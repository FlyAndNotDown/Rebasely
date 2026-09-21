use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub open_paths: Vec<String>,
    pub active: String,
    #[serde(default)]
    pub history_revs: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub history_expanded: HashMap<String, Vec<String>>,
}

impl Default for AppSession {
    fn default() -> Self {
        Self {
            open_paths: Vec::new(),
            active: "welcome".to_string(),
            history_revs: HashMap::new(),
            history_expanded: HashMap::new(),
        }
    }
}

fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|err| {
        crate::error::AppError::msg(format!("Could not resolve app data directory: {err}"))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("session.json"))
}

pub fn load_session(app: &AppHandle) -> AppResult<AppSession> {
    let path = session_path(app)?;
    if !path.exists() {
        return Ok(AppSession::default());
    }
    let data = fs::read_to_string(&path)?;
    let mut session: AppSession = serde_json::from_str(&data).unwrap_or_default();
    session.open_paths = session
        .open_paths
        .into_iter()
        .map(|item| strip_verbatim_prefix(&item))
        .filter(|item| !item.is_empty())
        .collect();
    session.active = strip_verbatim_prefix(&session.active);
    if session.active.is_empty() {
        session.active = "welcome".to_string();
    }
    session.history_revs = normalize_path_lists(session.history_revs);
    session.history_expanded = normalize_path_lists(session.history_expanded);
    Ok(session)
}

fn normalize_path_lists(map: HashMap<String, Vec<String>>) -> HashMap<String, Vec<String>> {
    map.into_iter()
        .filter_map(|(path, revs)| {
            let path = strip_verbatim_prefix(&path);
            if path.is_empty() {
                return None;
            }
            let revs = revs
                .into_iter()
                .map(|rev| rev.trim().to_string())
                .filter(|rev| !rev.is_empty())
                .collect();
            Some((path, revs))
        })
        .collect()
}

pub fn save_session(app: &AppHandle, mut session: AppSession) -> AppResult<AppSession> {
    session.open_paths = session
        .open_paths
        .into_iter()
        .map(|item| strip_verbatim_prefix(&item))
        .filter(|item| !item.is_empty())
        .collect();
    session.active = strip_verbatim_prefix(&session.active);
    if session.active.is_empty() {
        session.active = "welcome".to_string();
    }
    session.history_revs = normalize_path_lists(session.history_revs);
    session.history_expanded = normalize_path_lists(session.history_expanded);
    let path = session_path(app)?;
    fs::write(
        path,
        serde_json::to_string_pretty(&session).unwrap_or_else(|_| "{}".into()),
    )?;
    Ok(session)
}
