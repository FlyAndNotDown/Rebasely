use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalRect, WebviewWindow,
    WindowEvent,
};

use crate::error::AppResult;

const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 640.0;
const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 840.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
            maximized: true,
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
    let _ = crate::fsutil::write_atomic(&path, data.as_bytes());
}

fn clamp_size(width: f64, height: f64) -> (f64, f64) {
    (width.max(MIN_WIDTH), height.max(MIN_HEIGHT))
}

fn restoration_monitor(window: &WebviewWindow, state: &WindowState) -> Option<Monitor> {
    let monitors = window.available_monitors().unwrap_or_default();
    if let (Some(x), Some(y)) = (state.x, state.y) {
        if let Some(monitor) = monitors.iter().find(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            (x as f64) >= position.x
                && (y as f64) >= position.y
                && (x as f64) < position.x + size.width
                && (y as f64) < position.y + size.height
        }) {
            return Some(monitor.clone());
        }
    }
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

fn normal_frame(
    state: &WindowState,
    work_area: &PhysicalRect<i32, u32>,
    scale: f64,
) -> WindowState {
    let mut frame = state.clone();
    (frame.width, frame.height) = clamp_size(frame.width, frame.height);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    // Saved positions use whole logical pixels. Round the usable bounds inward.
    let left = (work_area.position.x as f64 / scale).ceil();
    let top = (work_area.position.y as f64 / scale).ceil();
    let right = ((work_area.position.x as f64 + work_area.size.width as f64) / scale).floor();
    let bottom = ((work_area.position.y as f64 + work_area.size.height as f64) / scale).floor();
    let available_width = right - left;
    let available_height = bottom - top;
    if available_width <= 0.0 || available_height <= 0.0 {
        return frame;
    }
    if state.maximized && (frame.width >= available_width || frame.height >= available_height) {
        // A maximized frame must not become the normal frame: borderless macOS
        // windows are considered maximized by size, even when positioned offscreen.
        // Leave room for a distinct normal frame on smaller displays as well.
        frame.width = DEFAULT_WIDTH.min((available_width - 32.0).max(MIN_WIDTH));
        frame.height = DEFAULT_HEIGHT.min((available_height - 32.0).max(MIN_HEIGHT));
    }
    frame.width = frame.width.min(available_width);
    frame.height = frame.height.min(available_height);
    let x = state
        .x
        .map(f64::from)
        .unwrap_or(left + (available_width - frame.width) / 2.0);
    let y = state
        .y
        .map(f64::from)
        .unwrap_or(top + (available_height - frame.height) / 2.0);
    frame.x = Some(x.clamp(left, (right - frame.width).floor()).round() as i32);
    frame.y = Some(y.clamp(top, (bottom - frame.height).floor()).round() as i32);
    frame
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
    let mut state = load_state(app).unwrap_or_default();
    if let Some(monitor) = restoration_monitor(window, &state) {
        let corrected = normal_frame(&state, monitor.work_area(), monitor.scale_factor());
        if corrected != state {
            // Maximized captures retain these normal bounds, so repair persistence first.
            save_state(app, &corrected);
        }
        state = corrected;
    }
    let (width, height) = clamp_size(state.width, state.height);
    // Construct the window unmaximized so these bounds become its normal frame.
    // Apply maximization last; macOS schedules native frame changes asynchronously.
    let _ = window.set_size(LogicalSize::new(width, height));
    if let (Some(x), Some(y)) = (state.x, state.y) {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
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

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};

    fn area(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    #[test]
    fn maximized_sized_saved_frame_gets_a_visible_normal_frame() {
        let state = WindowState {
            width: 1600.0,
            height: 1000.0,
            x: Some(0),
            y: Some(400),
            maximized: true,
        };
        let frame = normal_frame(&state, &area(0, 24, 1600, 1000), 1.0);
        assert_eq!((frame.width, frame.height), (1280.0, 840.0));
        assert_eq!((frame.x, frame.y), (Some(0), Some(184)));
        assert!(frame.maximized);
    }

    #[test]
    fn valid_saved_normal_bounds_are_preserved() {
        let state = WindowState {
            width: 1200.0,
            height: 800.0,
            x: Some(120),
            y: Some(80),
            maximized: true,
        };
        assert_eq!(normal_frame(&state, &area(0, 24, 1600, 1000), 1.0), state);
    }

    #[test]
    fn entire_window_is_kept_inside_a_negative_coordinate_monitor() {
        let state = WindowState {
            width: 1000.0,
            height: 700.0,
            x: Some(-50),
            y: Some(-400),
            maximized: false,
        };
        let frame = normal_frame(&state, &area(-1600, 40, 1600, 1000), 1.0);
        assert_eq!((frame.x, frame.y), (Some(-1000), Some(40)));
        assert_eq!((frame.width, frame.height), (1000.0, 700.0));
        assert!(!frame.maximized);
    }

    #[test]
    fn work_area_is_converted_using_monitor_scale() {
        let state = WindowState {
            width: 1500.0,
            height: 952.0,
            x: Some(-1500),
            y: Some(300),
            maximized: true,
        };
        let frame = normal_frame(&state, &area(-3000, 48, 3000, 1904), 2.0);
        assert_eq!((frame.width, frame.height), (1280.0, 840.0));
        assert_eq!((frame.x, frame.y), (Some(-1500), Some(136)));
    }

    #[test]
    fn fallback_frame_fits_smaller_work_areas_without_matching_maximized_size() {
        let state = WindowState {
            width: 1600.0,
            height: 800.0,
            ..WindowState::default()
        };
        let frame = normal_frame(&state, &area(0, 0, 1600, 800), 1.0);
        assert_eq!((frame.width, frame.height), (1280.0, 768.0));
        assert_eq!((frame.x, frame.y), (Some(160), Some(16)));
    }

    #[test]
    fn fractional_window_sizes_do_not_round_positions_past_the_work_area() {
        let state = WindowState {
            width: 1100.5,
            height: 700.5,
            x: Some(2000),
            y: Some(2000),
            maximized: false,
        };
        let frame = normal_frame(&state, &area(0, 0, 1600, 1000), 1.0);
        assert_eq!((frame.x, frame.y), (Some(499), Some(299)));
        assert_eq!((frame.width, frame.height), (1100.5, 700.5));
    }
}
