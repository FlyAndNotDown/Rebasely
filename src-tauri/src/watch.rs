use std::collections::HashMap;
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

pub struct WatchState {
    watchers: Arc<Mutex<HashMap<String, RecommendedWatcher>>>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    attach: Mutex<Option<mpsc::Sender<AttachRequest>>>,
    started: Mutex<bool>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
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

fn interesting(event: &Event) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|path| !ignored(path))
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

fn should_attach(root: &str, path: &Path) -> bool {
    let Some(depth) = relative_depth(root, path) else {
        return false;
    };
    if depth > WATCH_SPLIT_DEPTH as usize || ignored(path) {
        return false;
    }
    path.is_dir()
}

fn watch_tree(watcher: &mut RecommendedWatcher, path: &Path, depth: u8) -> notify::Result<()> {
    if depth >= WATCH_SPLIT_DEPTH {
        return watcher.watch(path, RecursiveMode::Recursive);
    }
    watcher.watch(path, RecursiveMode::NonRecursive)?;
    let Ok(entries) = fs::read_dir(path) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        let name = child.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if name.is_empty() || name == ".git" || skip_watch_dir(name) {
            continue;
        }
        let _ = watch_tree(watcher, &child, depth + 1);
    }
    Ok(())
}

fn watch_repo(watcher: &mut RecommendedWatcher, root: &Path) -> AppResult<()> {
    watch_tree(watcher, root, 0).map_err(|err| {
        crate::error::AppError::msg(format!("Could not watch folder: {err}"))
    })?;

    let git_dir = root.join(".git");
    if git_dir.is_dir() {
        let _ = watcher.watch(&git_dir, RecursiveMode::NonRecursive);
        let refs = git_dir.join("refs");
        if refs.is_dir() {
            let _ = watcher.watch(&refs, RecursiveMode::Recursive);
        }
    }
    Ok(())
}

fn note_change(pending: &Mutex<HashMap<String, Pending>>, repo: &str, event: &Event) {
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
        if ignored(path) {
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
) -> AppResult<RecommendedWatcher> {
    let emit_path = path.clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else { return };
        if !interesting(&event) {
            return;
        }
        if matches!(event.kind, EventKind::Create(_)) {
            for changed in &event.paths {
                if should_attach(&emit_path, changed) {
                    let _ = attach.send(AttachRequest {
                        root: emit_path.clone(),
                        path: changed.clone(),
                    });
                }
            }
        }
        note_change(pending.as_ref(), &emit_path, &event);
    })
    .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;

    watch_repo(&mut watcher, Path::new(&path))?;
    Ok(watcher)
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
            if ignored(&request.path) {
                continue;
            }
            let mut map = watchers.lock().unwrap_or_else(|err| err.into_inner());
            let Some(watcher) = map.get_mut(&request.root) else {
                continue;
            };
            let depth = relative_depth(&request.root, &request.path).unwrap_or(WATCH_SPLIT_DEPTH as usize);
            let _ = watch_tree(watcher, &request.path, depth as u8);
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
                    Some(item) if item.generation == generation && item.at.elapsed() >= DEBOUNCE => {
                        let item = map.remove(&path).expect("pending entry");
                        Some(RepoChanged {
                            path,
                            paths: if item.overflow { Vec::new() } else { item.paths },
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

    let wanted: Vec<String> = paths
        .into_iter()
        .map(|path| strip_verbatim_prefix(&path))
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .collect();

    {
        let mut watchers = state.watchers.lock().unwrap_or_else(|err| err.into_inner());
        watchers.retain(|path, _| wanted.contains(path));
    }

    for path in wanted {
        {
            let watchers = state.watchers.lock().unwrap_or_else(|err| err.into_inner());
            if watchers.contains_key(&path) {
                continue;
            }
        }
        if let Ok(watcher) = watch_path(path.clone(), state.pending.clone(), attach.clone()) {
            let mut watchers = state.watchers.lock().unwrap_or_else(|err| err.into_inner());
            if !watchers.contains_key(&path) {
                watchers.insert(path, watcher);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ignored;
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
    }
}
