use serde::{Deserialize, Serialize};
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
}

impl Default for AppSession {
    fn default() -> Self {
        Self {
            open_paths: Vec::new(),
            active: "welcome".to_string(),
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
    Ok(session)
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
    let path = session_path(app)?;
    fs::write(
        path,
        serde_json::to_string_pretty(&session).unwrap_or_else(|_| "{}".into()),
    )?;
    Ok(session)
}
