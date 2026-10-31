use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::error::AppResult;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelLayouts {
    #[serde(default)]
    pub history_shell: HashMap<String, f64>,
    #[serde(default)]
    pub history: HashMap<String, f64>,
    #[serde(default)]
    pub history_details: HashMap<String, f64>,
    #[serde(default)]
    pub changes: HashMap<String, f64>,
    #[serde(default)]
    pub stash: HashMap<String, f64>,
    #[serde(default)]
    pub stash_details: HashMap<String, f64>,
    #[serde(default)]
    pub files: HashMap<String, f64>,
    #[serde(default)]
    pub file_history: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    #[serde(default = "default_editor_id")]
    pub editor_id: String,
    #[serde(default = "default_sidebar_order")]
    pub sidebar_order: Vec<String>,
    #[serde(default)]
    pub panel_layouts: PanelLayouts,
    #[serde(default)]
    pub pull_rebase: bool,
    #[serde(default)]
    pub changes_tree: bool,
    #[serde(default)]
    pub diff_split: bool,
    #[serde(default)]
    pub diff_ignore_whitespace: bool,
    /// Minutes between background fetches; 0 turns them off.
    #[serde(default = "default_auto_fetch_minutes")]
    pub auto_fetch_minutes: u32,
    #[serde(default)]
    pub fetch_prune: bool,
    /// Empty uses the `git` executable on PATH.
    #[serde(default)]
    pub git_path: String,
    /// User-added executables. The PATH entry is not stored here.
    #[serde(default)]
    pub extra_git_paths: Vec<String>,
    /// Empty uses the `p4` executable on PATH.
    #[serde(default)]
    pub p4_path: String,
    /// User-added p4 executables. The PATH entry is not stored here.
    #[serde(default)]
    pub extra_p4_paths: Vec<String>,
    /// Default server for a new Perforce workspace.
    #[serde(default)]
    pub p4_port: String,
    /// Default user for a new Perforce workspace.
    #[serde(default)]
    pub p4_user: String,
    /// Empty leaves charset unset. Otherwise a value such as `utf8`.
    #[serde(default)]
    pub p4_charset: String,
    /// Minutes between background refreshes of an open Perforce workspace; 0 turns them off.
    #[serde(default = "default_p4_refresh_minutes")]
    pub p4_refresh_minutes: u32,
}

fn default_p4_refresh_minutes() -> u32 {
    60
}

fn default_auto_fetch_minutes() -> u32 {
    60
}

fn default_terminal_id() -> String {
    "auto".to_string()
}

fn default_editor_id() -> String {
    "system".to_string()
}

fn default_sidebar_order() -> Vec<String> {
    vec![
        "changes".to_string(),
        "history".to_string(),
        "stash".to_string(),
        "files".to_string(),
    ]
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            terminal_id: default_terminal_id(),
            editor_id: default_editor_id(),
            sidebar_order: default_sidebar_order(),
            panel_layouts: PanelLayouts::default(),
            pull_rebase: false,
            changes_tree: false,
            diff_split: false,
            diff_ignore_whitespace: false,
            auto_fetch_minutes: default_auto_fetch_minutes(),
            fetch_prune: false,
            git_path: String::new(),
            extra_git_paths: Vec::new(),
            p4_path: String::new(),
            extra_p4_paths: Vec::new(),
            p4_port: String::new(),
            p4_user: String::new(),
            p4_charset: String::new(),
            p4_refresh_minutes: default_p4_refresh_minutes(),
        }
    }
}

fn prefs_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|err| {
        crate::error::AppError::msg(format!("Could not resolve app data directory: {err}"))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("prefs.json"))
}

pub fn load_prefs(app: &AppHandle) -> AppResult<AppPrefs> {
    let path = prefs_path(app)?;
    if !path.exists() {
        return Ok(AppPrefs::default());
    }
    let data = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&data).unwrap_or_default())
}

pub fn save_prefs(app: &AppHandle, prefs: AppPrefs) -> AppResult<AppPrefs> {
    let path = prefs_path(app)?;
    crate::fsutil::write_atomic(
        &path,
        serde_json::to_string_pretty(&prefs)
            .unwrap_or_else(|_| "{}".into())
            .as_bytes(),
    )?;
    Ok(prefs)
}
