use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

const MAX_RECENTS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
}

fn recents_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|err| {
        crate::error::AppError::msg(format!("Could not resolve app data directory: {err}"))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("recents.json"))
}

pub fn load_recents(app: &AppHandle) -> AppResult<Vec<RecentRepo>> {
    let path = recents_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)?;
    let mut recents: Vec<RecentRepo> = serde_json::from_str(&data).unwrap_or_default();
    let mut changed = false;
    for item in &mut recents {
        let normalized = strip_verbatim_prefix(&item.path);
        if normalized != item.path {
            item.path = normalized;
            changed = true;
        }
    }
    if changed {
        let _ = save_recents(app, &recents);
    }
    Ok(recents)
}

fn save_recents(app: &AppHandle, recents: &[RecentRepo]) -> AppResult<()> {
    let path = recents_path(app)?;
    fs::write(path, serde_json::to_string_pretty(recents).unwrap_or_else(|_| "[]".into()))?;
    Ok(())
}

pub fn remember_repo(app: &AppHandle, path: &str, name: &str) -> AppResult<Vec<RecentRepo>> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path = strip_verbatim_prefix(path);
    let mut recents = load_recents(app)?;
    recents.retain(|item| item.path != path);
    recents.insert(
        0,
        RecentRepo {
            path,
            name: name.to_string(),
            last_opened: now,
        },
    );
    recents.truncate(MAX_RECENTS);
    save_recents(app, &recents)?;
    Ok(recents)
}

pub fn forget_repo(app: &AppHandle, path: &str) -> AppResult<Vec<RecentRepo>> {
    let path = strip_verbatim_prefix(path);
    let mut recents = load_recents(app)?;
    recents.retain(|item| item.path != path);
    save_recents(app, &recents)?;
    Ok(recents)
}
