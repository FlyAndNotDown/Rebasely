use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRepo {
    pub path: String,
    #[serde(default = "default_vcs")]
    pub vcs: String,
}

fn default_vcs() -> String {
    "git".to_string()
}

fn normalize_vcs(vcs: &str) -> String {
    if vcs == "perforce" {
        "perforce".to_string()
    } else {
        "git".to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub open_paths: Vec<String>,
    /// Which system each open folder belongs to. Empty for sessions saved
    /// before Perforce support; those paths are Git repositories.
    #[serde(default)]
    pub open_repos: Vec<OpenRepo>,
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
            open_repos: Vec::new(),
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
    session.open_repos = normalize_open_repos(session.open_repos, &session.open_paths);
    session.open_paths = session
        .open_repos
        .iter()
        .map(|repo| repo.path.clone())
        .collect();
    session.active = strip_verbatim_prefix(&session.active);
    if session.active.is_empty() {
        session.active = "welcome".to_string();
    }
    session.history_revs = normalize_path_lists(session.history_revs);
    session.history_expanded = normalize_path_lists(session.history_expanded);
    Ok(session)
}

fn normalize_open_repos(repos: Vec<OpenRepo>, paths: &[String]) -> Vec<OpenRepo> {
    let mut source = repos;
    if source.is_empty() {
        source = paths
            .iter()
            .map(|path| OpenRepo {
                path: path.clone(),
                vcs: default_vcs(),
            })
            .collect();
    }
    let mut kept = Vec::new();
    for repo in source {
        let path = strip_verbatim_prefix(&repo.path);
        if path.is_empty() {
            continue;
        }
        let vcs = normalize_vcs(&repo.vcs);
        if kept
            .iter()
            .any(|item: &OpenRepo| item.path == path && item.vcs == vcs)
        {
            continue;
        }
        kept.push(OpenRepo { path, vcs });
    }
    kept
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
    session.open_repos = normalize_open_repos(session.open_repos, &session.open_paths);
    session.open_paths = session
        .open_repos
        .iter()
        .map(|repo| repo.path.clone())
        .collect();
    session.active = strip_verbatim_prefix(&session.active);
    if session.active.is_empty() {
        session.active = "welcome".to_string();
    }
    session.history_revs = normalize_path_lists(session.history_revs);
    session.history_expanded = normalize_path_lists(session.history_expanded);
    let path = session_path(app)?;
    crate::fsutil::write_atomic(
        &path,
        serde_json::to_string_pretty(&session)
            .unwrap_or_else(|_| "{}".into())
            .as_bytes(),
    )?;
    Ok(session)
}
