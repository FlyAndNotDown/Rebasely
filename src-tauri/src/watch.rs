use std::collections::HashMap;
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

fn ignored(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.contains(".git\\objects")
        || text.contains(".git/objects")
        || text.ends_with(".lock")
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

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|err| crate::error::AppError::msg(format!("Could not watch folder: {err}")))?;
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
