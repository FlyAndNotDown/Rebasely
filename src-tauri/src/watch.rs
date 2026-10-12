use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

const DEBOUNCE: Duration = Duration::from_millis(600);
const MAX_CHANGED_PATHS: usize = 48;
/// Walk this many levels so output folders are never part of a recursive watch.
/// Deeper folders get one recursive watch, and new directories above this depth
/// are attached when they are created.
const WATCH_SPLIT_DEPTH: u8 = 4;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    path: String,
    paths: Vec<String>,
    overflow: bool,
}

struct Pending {
    generation: u64,
    at: Instant,
    paths: Vec<String>,
    overflow: bool,
}

struct AttachRequest {
    root: String,
    path: PathBuf,
}

#[derive(Default)]
struct WatchPlan {
    wanted: HashSet<String>,
    /// Roots whose watcher is still being built on a background thread.
    starting: HashSet<String>,
}

struct WatchEntry {
    watcher: RecommendedWatcher,
    rules: Arc<IgnoreRules>,
}

pub struct WatchState {
    watchers: Arc<Mutex<HashMap<String, WatchEntry>>>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    plan: Arc<Mutex<WatchPlan>>,
    attach: Mutex<Option<mpsc::Sender<AttachRequest>>>,
    started: Mutex<bool>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            plan: Arc::new(Mutex::new(WatchPlan::default())),
            attach: Mutex::new(None),
            started: Mutex::new(false),
        }
    }
}

fn skip_watch_dir(name: &str) -> bool {
    matches!(
        name,
        "Intermediate"
            | "Binaries"
            | "DerivedDataCache"
            | "Saved"
            | "Build"
            | "node_modules"
            | "target"
            | "dist"
            | ".vs"
            | ".idea"
    )
}

fn ignored(path: &Path) -> bool {
    let mut under_git = false;
    for component in path.components() {
        let Some(name) = component.as_os_str().to_str() else {
            continue;
        };
        if under_git && name == "objects" {
            return true;
        }
        if skip_watch_dir(name) {
            return true;
        }
        under_git = name == ".git";
    }
    let text = path.to_string_lossy();
    text.ends_with(".lock") || text.ends_with(".tmp")
}

/// The fixed list above plus the repository's own ignore rules (`.gitignore`
/// files, `.git/info/exclude`, and the global excludes file), so build output
/// the project ignores neither gets watched nor triggers a refresh.
struct IgnoreRules {
    root: PathBuf,
    repo: Option<crate::git::Repository>,
    cache: Mutex<HashMap<String, (u128, bool)>>,
}

impl IgnoreRules {
    fn open(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            repo: crate::git::open_at(root).ok(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn fixed_only() -> Self {
        Self {
            root: PathBuf::new(),
            repo: None,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn ignores(&self, path: &Path) -> bool {
        self.ignores_as(path, false)
    }

    fn ignores_dir(&self, path: &Path) -> bool {
        self.ignores_as(path, true)
    }

    fn ignores_as(&self, path: &Path, dir: bool) -> bool {
        if ignored(path) {
            return true;
        }
        let Some(rel) = relative_path(&self.root, path) else {
            return false;
        };
        if rel == ".git" || rel.starts_with(".git/") {
            return false;
        }
        let query = if dir { format!("{rel}/") } else { rel };
        self.query_ignored(&query)
    }

    /// One `git check-ignore` for a whole directory of children. A failure is
    /// treated as "not ignored" so a transient git error still delivers events.
    fn ignored_set(&self, queries: &[String]) -> HashSet<String> {
        let Some(repo) = &self.repo else {
            return HashSet::new();
        };
        let mut ignored = HashSet::new();
        let mut missing = Vec::new();
        let mut guard = self.cache.lock().unwrap_or_else(|err| err.into_inner());
        for query in queries {
            let stamp = ignore_stamp(repo, query);
            if let Some((cached_stamp, value)) = guard.get(query) {
                if *cached_stamp == stamp {
                    if *value {
                        ignored.insert(query.clone());
                    }
                    continue;
                }
            }
            missing.push((query.clone(), stamp));
        }
        if missing.is_empty() {
            return ignored;
        }
        let asked: Vec<String> = missing.iter().map(|(query, _)| query.clone()).collect();
        let found = crate::git::ignored_queries(repo, &asked).unwrap_or_default();
        for (query, stamp) in missing {
            let value = found.contains(&query);
            if value {
                ignored.insert(query.clone());
            }
            guard.insert(query, (stamp, value));
        }
        ignored
    }

    fn query_ignored(&self, query: &str) -> bool {
        self.ignored_set(std::slice::from_ref(&query.to_string()))
            .contains(query)
    }
}

fn ignore_stamp(repo: &crate::git::Repository, query: &str) -> u128 {
    fn mtime(path: &Path) -> u128 {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    }
    let mut stamp = mtime(&repo.path().join("index"));
    stamp = stamp.wrapping_add(mtime(&repo.path().join("info").join("exclude")));
    stamp = stamp.wrapping_add(mtime(&repo.commondir().join("info").join("exclude")));
    stamp = stamp.wrapping_add(mtime(&repo.workdir().join(".gitignore")));
    let mut dir = Path::new(query.trim_end_matches('/'));
    while let Some(parent) = dir.parent() {
        stamp = stamp.wrapping_add(mtime(&repo.workdir().join(parent).join(".gitignore")));
        if parent.as_os_str().is_empty() {
            break;
        }
        dir = parent;
    }
    stamp
}

/// `path` relative to `root` with forward slashes; None for the root itself or outside it.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let root = strip_verbatim_prefix(&root.to_string_lossy());
    let path = strip_verbatim_prefix(&path.to_string_lossy());
    let rel = Path::new(&path).strip_prefix(Path::new(&root)).ok()?;
    let parts: Vec<_> = rel
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn interesting(event: &Event, rules: &IgnoreRules) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|path| !rules.ignores(path))
}

fn relative_depth(root: &str, path: &Path) -> Option<usize> {
    let root_text = strip_verbatim_prefix(root);
    let path_text = strip_verbatim_prefix(&path.to_string_lossy());
    Path::new(&path_text)
        .strip_prefix(Path::new(&root_text))
        .ok()
        .map(|rel| rel.components().count())
        .filter(|depth| *depth > 0)
}

fn should_attach(root: &str, path: &Path, rules: &IgnoreRules) -> bool {
    let Some(depth) = relative_depth(root, path) else {
        return false;
    };
    depth <= WATCH_SPLIT_DEPTH as usize && path.is_dir() && !rules.ignores_dir(path)
}

fn watch_tree(
    watcher: &mut RecommendedWatcher,
    path: &Path,
    depth: u8,
    rules: &IgnoreRules,
) -> notify::Result<()> {
    if depth >= WATCH_SPLIT_DEPTH {
        return watcher.watch(path, RecursiveMode::Recursive);
    }
    watcher.watch(path, RecursiveMode::NonRecursive)?;
    let Ok(entries) = fs::read_dir(path) else {
        return Ok(());
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        let name = child
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.is_empty() || name == ".git" || ignored(&child) {
            continue;
        }
        children.push(child);
    }
    let queries: Vec<String> = children
        .iter()
        .filter_map(|child| relative_path(&rules.root, child))
        .map(|rel| format!("{rel}/"))
        .collect();
    let ignored_dirs = rules.ignored_set(&queries);
    for child in children {
        let Some(rel) = relative_path(&rules.root, &child) else {
            continue;
        };
        if ignored_dirs.contains(&format!("{rel}/")) {
            continue;
        }
        let _ = watch_tree(watcher, &child, depth + 1, rules);
    }
    Ok(())
}

fn watch_repo(watcher: &mut RecommendedWatcher, root: &Path, rules: &IgnoreRules) -> AppResult<()> {
    watch_tree(watcher, root, 0, rules)
        .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;

    // A linked worktree has a `.git` file pointing at its own git folder, and
    // shares refs with the main repository's.
    let (git_dir, common_dir) = match crate::git::open_at(root) {
        Ok(repo) => (repo.path().to_path_buf(), repo.commondir().to_path_buf()),
        Err(_) => (root.join(".git"), root.join(".git")),
    };
    if git_dir.is_dir() {
        let _ = watcher.watch(&git_dir, RecursiveMode::NonRecursive);
    }
    if common_dir != git_dir && common_dir.is_dir() {
        let _ = watcher.watch(&common_dir, RecursiveMode::NonRecursive);
    }
    let refs = common_dir.join("refs");
    if refs.is_dir() {
        let _ = watcher.watch(&refs, RecursiveMode::Recursive);
    }
    Ok(())
}

fn note_change(
    pending: &Mutex<HashMap<String, Pending>>,
    repo: &str,
    event: &Event,
    rules: &IgnoreRules,
) {
    let mut map = pending.lock().unwrap_or_else(|err| err.into_inner());
    let slot = map.entry(repo.to_string()).or_insert_with(|| Pending {
        generation: 0,
        at: Instant::now(),
        paths: Vec::new(),
        overflow: false,
    });
    slot.generation = slot.generation.wrapping_add(1);
    slot.at = Instant::now();
    if slot.overflow {
        return;
    }
    for path in &event.paths {
        if rules.ignores(path) {
            continue;
        }
        if slot.paths.len() >= MAX_CHANGED_PATHS {
            slot.overflow = true;
            slot.paths.clear();
            return;
        }
        let text = path.to_string_lossy().into_owned();
        if !slot.paths.iter().any(|existing| existing == &text) {
            slot.paths.push(text);
        }
    }
}

fn watch_path(
    path: String,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    attach: mpsc::Sender<AttachRequest>,
) -> AppResult<WatchEntry> {
    let rules = Arc::new(IgnoreRules::open(Path::new(&path)));
    let emit_path = path.clone();
    let event_rules = rules.clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else { return };
        if !interesting(&event, &event_rules) {
            return;
        }
        if matches!(event.kind, EventKind::Create(_)) {
            for changed in &event.paths {
                if should_attach(&emit_path, changed, &event_rules) {
                    let _ = attach.send(AttachRequest {
                        root: emit_path.clone(),
                        path: changed.clone(),
                    });
                }
            }
        }
        note_change(pending.as_ref(), &emit_path, &event, &event_rules);
    })
    .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;

    watch_repo(&mut watcher, Path::new(&path), &rules)?;
    Ok(WatchEntry { watcher, rules })
}

fn ensure_debouncer(app: &AppHandle, state: &WatchState) {
    let mut started = state.started.lock().unwrap_or_else(|err| err.into_inner());
    if *started {
        return;
    }
    *started = true;
    drop(started);

    let (sender, receiver) = mpsc::channel();
    *state.attach.lock().unwrap_or_else(|err| err.into_inner()) = Some(sender);
    let pending = state.pending.clone();
    let watchers = state.watchers.clone();
    let app = app.clone();
    thread::spawn(move || loop {
        while let Ok(request) = receiver.try_recv() {
            let mut map = watchers.lock().unwrap_or_else(|err| err.into_inner());
            let Some(entry) = map.get_mut(&request.root) else {
                continue;
            };
            if entry.rules.ignores_dir(&request.path) {
                continue;
            }
            let depth =
                relative_depth(&request.root, &request.path).unwrap_or(WATCH_SPLIT_DEPTH as usize);
            let rules = entry.rules.clone();
            let _ = watch_tree(&mut entry.watcher, &request.path, depth as u8, &rules);
        }

        thread::sleep(Duration::from_millis(150));
        let now = Instant::now();
        let due: Vec<(String, u64)> = {
            let map = pending.lock().unwrap_or_else(|err| err.into_inner());
            map.iter()
                .filter(|(_, item)| now.duration_since(item.at) >= DEBOUNCE)
                .map(|(path, item)| (path.clone(), item.generation))
                .collect()
        };
        for (path, generation) in due {
            let payload = {
                let mut map = pending.lock().unwrap_or_else(|err| err.into_inner());
                match map.get(&path) {
                    Some(item)
                        if item.generation == generation && item.at.elapsed() >= DEBOUNCE =>
                    {
                        let item = map.remove(&path).expect("pending entry");
                        Some(RepoChanged {
                            path,
                            paths: if item.overflow {
                                Vec::new()
                            } else {
                                item.paths
                            },
                            overflow: item.overflow,
                        })
                    }
                    _ => None,
                }
            };
            if let Some(payload) = payload {
                let _ = app.emit("repo-changed", payload);
            }
        }
    });
}

pub fn sync_watches(app: &AppHandle, state: &WatchState, paths: Vec<String>) -> AppResult<()> {
    ensure_debouncer(app, state);
    let attach = state
        .attach
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
        .ok_or_else(|| crate::error::AppError::msg("Could not watch folder"))?;

    let wanted: HashSet<String> = paths
        .into_iter()
        .map(|path| strip_verbatim_prefix(&path))
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .collect();

    // This runs on the caller's thread in call order, so the wanted set is
    // always the latest one. Building a watcher walks the tree, which can take
    // seconds on a large repository, so that part happens on its own thread.
    let to_start: Vec<String> = {
        let mut plan = state.plan.lock().unwrap_or_else(|err| err.into_inner());
        let mut watchers = state.watchers.lock().unwrap_or_else(|err| err.into_inner());
        watchers.retain(|path, _| wanted.contains(path));
        let to_start = wanted
            .iter()
            .filter(|path| !watchers.contains_key(*path) && !plan.starting.contains(*path))
            .cloned()
            .collect::<Vec<_>>();
        plan.starting.extend(to_start.iter().cloned());
        plan.wanted = wanted;
        to_start
    };

    for path in to_start {
        let watchers = state.watchers.clone();
        let pending = state.pending.clone();
        let plan = state.plan.clone();
        let attach = attach.clone();
        thread::spawn(move || {
            let entry = watch_path(path.clone(), pending, attach).ok();
            let mut plan = plan.lock().unwrap_or_else(|err| err.into_inner());
            plan.starting.remove(&path);
            let Some(entry) = entry else { return };
            if !plan.wanted.contains(&path) {
                return;
            }
            watchers
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .entry(path)
                .or_insert(entry);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ignored, IgnoreRules};
    use std::fs;
    use std::path::Path;

    #[test]
    fn skips_nested_build_output_and_git_objects() {
        assert!(ignored(Path::new(
            r"C:\work\repo\module\Intermediate\Build\cache.obj"
        )));
        assert!(ignored(Path::new(
            r"C:\work\repo\module\Binaries\Win64\app.exe"
        )));
        assert!(ignored(Path::new(r"C:\work\repo\.git\objects\ab\cd")));
        assert!(ignored(Path::new(r"C:\work\repo\.git\index.lock")));
        assert!(!ignored(Path::new(
            r"C:\work\repo\module\src\detail\impl.cpp"
        )));
        assert!(!ignored(Path::new(r"C:\work\repo\.git\index")));
        assert!(!ignored(Path::new(r"C:\work\repo\.git\refs\heads\main")));
        assert!(!IgnoreRules::fixed_only().ignores(Path::new(r"C:\work\repo\module\src\a.cpp")));
    }

    #[test]
    fn follows_the_repository_gitignore_except_for_tracked_files() {
        let root = std::env::temp_dir().join(format!("rebasely-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("out")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let git = |args: &[&str]| {
            let mut command = std::process::Command::new("git");
            command.arg("-C").arg(&root).args(args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            assert!(command.status().unwrap().success(), "{args:?}");
        };
        git(&["init"]);
        fs::write(root.join(".gitignore"), "out/\n*.log\n").unwrap();
        fs::write(root.join("kept.log"), "tracked anyway\n").unwrap();
        git(&["add", "-f", "--", "kept.log"]);

        let rules = IgnoreRules::open(&root);
        assert!(rules.ignores_dir(&root.join("out")));
        assert!(rules.ignores(&root.join("out").join("app.o")));
        assert!(rules.ignores(&root.join("debug.log")));
        assert!(!rules.ignores(&root.join("kept.log")));
        assert!(!rules.ignores(&root.join("src").join("main.rs")));
        assert!(!rules.ignores_dir(&root.join("src")));
        assert!(!rules.ignores(&root.join(".git").join("index")));
        let _ = fs::remove_dir_all(&root);
    }
}
