use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent};

use crate::error::AppResult;

const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 640.0;
const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 840.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    #[serde(default)]
    pub maximized: bool,
}

fn default_width() -> f64 {
    DEFAULT_WIDTH
}

fn default_height() -> f64 {
    DEFAULT_HEIGHT
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

fn state_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|err| {
        crate::error::AppError::msg(format!("Could not resolve app data directory: {err}"))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("window.json"))
}

fn load_state(app: &AppHandle) -> Option<WindowState> {
    let path = state_path(app).ok()?;
    if !path.exists() {
        return None;
    }
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_state(app: &AppHandle, state: &WindowState) {
    let Ok(path) = state_path(app) else {
        return;
    };
    let Ok(data) = serde_json::to_string_pretty(state) else {
        return;
    };
    let _ = fs::write(path, data);
}

fn clamp_size(width: f64, height: f64) -> (f64, f64) {
    (width.max(MIN_WIDTH), height.max(MIN_HEIGHT))
}

fn position_on_a_monitor(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(scale) = window.scale_factor() else {
        return true;
    };
    let px = (x as f64 * scale).round() as i32;
    let py = (y as f64 * scale).round() as i32;
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        px >= pos.x
            && py >= pos.y
            && px < pos.x + size.width as i32
            && py < pos.y + size.height as i32
    })
}

fn capture(window: &WebviewWindow, previous: Option<WindowState>) -> WindowState {
    let previous = previous.unwrap_or_default();
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        return WindowState {
            maximized: true,
            ..previous
        };
    }

    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let size = window.inner_size().ok();
    let position = window.outer_position().ok();
    let (width, height) = if let Some(size) = size {
        clamp_size(size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (previous.width, previous.height)
    };
    let (x, y) = if let Some(position) = position {
        (
            Some((position.x as f64 / scale).round() as i32),
            Some((position.y as f64 / scale).round() as i32),
        )
    } else {
        (previous.x, previous.y)
    };

    WindowState {
        width,
        height,
        x,
        y,
        maximized: false,
    }
}

fn persist(window: &WebviewWindow, app: &AppHandle) {
    let previous = load_state(app);
    save_state(app, &capture(window, previous));
}

pub fn restore(window: &WebviewWindow, app: &AppHandle) {
    let Some(state) = load_state(app) else {
        return;
    };
    let (width, height) = clamp_size(state.width, state.height);
    let _ = window.set_size(LogicalSize::new(width, height));
    if let (Some(x), Some(y)) = (state.x, state.y) {
        if position_on_a_monitor(window, x, y) {
            let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
        }
    }
    if state.maximized {
        let _ = window.maximize();
    }
}

pub fn watch(window: &WebviewWindow, app: &AppHandle) {
    let app = app.clone();
    let label = window.label().to_string();
    let generations = Arc::new(Mutex::new(0_u64));

    window.on_window_event(move |event| {
        let should_save = matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::CloseRequested { .. }
        );
        if !should_save {
            return;
        }
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            persist(&window, &app);
            return;
        }

        let generation = {
            let mut slot = generations.lock().unwrap_or_else(|err| err.into_inner());
            *slot += 1;
            *slot
        };
        let generations = generations.clone();
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            let current = generations
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .to_owned();
            if current == generation {
                persist(&window, &app);
            }
        });
    });
}
