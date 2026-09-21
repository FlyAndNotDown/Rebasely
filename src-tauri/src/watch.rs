use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
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
    let text = path.to_string_lossy();
    if skip_watch_dir(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    ) {
        return true;
    }
    text.contains(".git\\objects")
        || text.contains(".git/objects")
        || text.contains(".git\\objects\\")
        || text.contains(".git/objects/")
        || text.ends_with(".lock")
        || text.ends_with(".tmp")
        || text.ends_with("\\index.lock")
        || text.ends_with("/index.lock")
}

fn interesting(event: &Event) -> bool {
    use notify::EventKind;
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|path| !ignored(path))
}

fn watch_repo(watcher: &mut RecommendedWatcher, root: &Path) -> AppResult<()> {
    watcher
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;

    let git_dir = root.join(".git");
    if git_dir.is_dir() {
        let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
    }

    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
            if name == ".git" || skip_watch_dir(name) {
                continue;
            }
            let _ = watcher.watch(&path, RecursiveMode::Recursive);
        }
    }
    Ok(())
}

fn watch_path(app: AppHandle, path: String, generations: Arc<Mutex<HashMap<String, u64>>>) -> AppResult<RecommendedWatcher> {
    let emit_path = path.clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let Ok(event) = result else { return };
        if !interesting(&event) {
            return;
        }
        let generation = {
            let mut gens = generations.lock().unwrap_or_else(|err| err.into_inner());
            let slot = gens.entry(emit_path.clone()).or_insert(0);
            *slot += 1;
            *slot
        };
        let app = app.clone();
        let emit_path = emit_path.clone();
        let generations = generations.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            let current = generations
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .get(&emit_path)
                .copied();
            if current == Some(generation) {
                let _ = app.emit("repo-changed", emit_path);
            }
        });
    })
    .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;

    watch_repo(&mut watcher, Path::new(&path))?;
    Ok(watcher)
}

pub fn sync_watches(app: &AppHandle, state: &WatchState, paths: Vec<String>) -> AppResult<()> {
    let wanted: Vec<String> = paths
        .into_iter()
        .map(|path| strip_verbatim_prefix(&path))
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .collect();

    let mut watchers = state.watchers.lock().unwrap_or_else(|err| err.into_inner());
    watchers.retain(|path, _| wanted.contains(path));

    for path in wanted {
        if watchers.contains_key(&path) {
            continue;
        }
        if let Ok(watcher) = watch_path(app.clone(), path.clone(), state.generations.clone()) {
            watchers.insert(path, watcher);
        }
    }
    Ok(())
}
