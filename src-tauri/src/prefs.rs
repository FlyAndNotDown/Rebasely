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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    #[serde(default = "default_terminal_id")]
    pub terminal_id: String,
    #[serde(default = "default_avatar_provider")]
    pub avatar_provider: String,
    #[serde(default = "default_sidebar_order")]
    pub sidebar_order: Vec<String>,
    #[serde(default)]
    pub panel_layouts: PanelLayouts,
}

fn default_terminal_id() -> String {
    "auto".to_string()
}

fn default_avatar_provider() -> String {
    "dicebear".to_string()
}

fn default_sidebar_order() -> Vec<String> {
    vec![
        "changes".to_string(),
        "history".to_string(),
        "stash".to_string(),
    ]
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            terminal_id: default_terminal_id(),
            avatar_provider: default_avatar_provider(),
            sidebar_order: default_sidebar_order(),
            panel_layouts: PanelLayouts::default(),
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
    fs::write(
        path,
        serde_json::to_string_pretty(&prefs).unwrap_or_else(|_| "{}".into()),
    )?;
    Ok(prefs)
}
