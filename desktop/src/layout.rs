//! Window geometry for the normal and compact form factors, remembered separately.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window, WindowEvent};

use crate::board;

const NORMAL_SIZE: (f64, f64) = (1280.0, 800.0);
const COMPACT_SIZE: (f64, f64) = (440.0, 600.0);
const COMPACT_MARGIN: f64 = 16.0;
/// A saved rect must overlap a monitor by this much to be restored.
const MIN_VISIBLE: i64 = 64;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Layout {
    normal: Option<Rect>,
    normal_maximized: bool,
    compact: Option<Rect>,
    compact_mode: bool,
    compact_on_top: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            normal: None,
            normal_maximized: false,
            compact: None,
            compact_mode: false,
            compact_on_top: true,
        }
    }
}

pub struct LayoutState {
    layout: Mutex<Layout>,
    path: PathBuf,
    last_maximized: Mutex<bool>,
}

/// What the board page needs to draw its window controls and desktop settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    compact: bool,
    maximized: bool,
    compact_on_top: bool,
    open_from_agents: bool,
}

pub fn load<R: Runtime>(app: &tauri::AppHandle<R>) -> LayoutState {
    let path = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| board::data_dir())
        .join("window.json");
    let layout = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    LayoutState {
        layout: Mutex::new(layout),
        path,
        last_maximized: Mutex::new(false),
    }
}

fn state<R: Runtime>(window: &WebviewWindow<R>) -> tauri::State<'_, LayoutState> {
    window.state::<LayoutState>()
}

fn save(state: &LayoutState, layout: &Layout) {
    if let Some(dir) = state.path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(layout) {
        let _ = std::fs::write(&state.path, text);
    }
}

/// Size and place the hidden window before it is first shown.
pub fn apply_initial<R: Runtime>(window: &WebviewWindow<R>) {
    let state = state(window);
    let layout = state.layout.lock().unwrap();
    if layout.compact_mode {
        let rect = on_screen(window, layout.compact).unwrap_or_else(|| default_compact(window));
        apply(window, rect);
        let _ = window.set_always_on_top(layout.compact_on_top);
        return;
    }
    match on_screen(window, layout.normal) {
        Some(rect) => apply(window, rect),
        None => {
            let _ = window.set_size(tauri::LogicalSize::new(NORMAL_SIZE.0, NORMAL_SIZE.1));
            let _ = window.center();
        }
    }
    if layout.normal_maximized {
        let _ = window.maximize();
    }
}

pub fn toggle_compact<R: Runtime>(window: &WebviewWindow<R>) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let maximized = window.is_maximized().unwrap_or(false);
    if layout.compact_mode {
        if !maximized {
            layout.compact = current_rect(window);
        } else {
            let _ = window.unmaximize();
        }
        layout.compact_mode = false;
        let _ = window.set_always_on_top(false);
        match on_screen(window, layout.normal) {
            Some(rect) => apply(window, rect),
            None => {
                let _ = window.set_size(tauri::LogicalSize::new(NORMAL_SIZE.0, NORMAL_SIZE.1));
                let _ = window.center();
            }
        }
        if layout.normal_maximized {
            let _ = window.maximize();
        }
    } else {
        layout.normal_maximized = maximized;
        if maximized {
            let _ = window.unmaximize();
        } else {
            layout.normal = current_rect(window);
        }
        layout.compact_mode = true;
        let rect = on_screen(window, layout.compact).unwrap_or_else(|| default_compact(window));
        apply(window, rect);
        let _ = window.set_always_on_top(layout.compact_on_top);
    }
    save(&state, &layout);
    drop(layout);
    let _ = window.set_focus();
    push_state(window);
}

pub fn set_compact_on_top<R: Runtime>(window: &WebviewWindow<R>, on_top: bool) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    layout.compact_on_top = on_top;
    if layout.compact_mode {
        let _ = window.set_always_on_top(on_top);
    }
    save(&state, &layout);
}

pub fn desktop_state<R: Runtime>(window: &WebviewWindow<R>) -> DesktopState {
    let state = state(window);
    let layout = state.layout.lock().unwrap();
    DesktopState {
        compact: layout.compact_mode,
        maximized: window.is_maximized().unwrap_or(false),
        compact_on_top: layout.compact_on_top,
        open_from_agents: board::read_registration().is_none_or(|registration| registration.open_from_agents),
    }
}

/// Tell the page about a change it did not ask for (shortcut, snap, double-click maximize).
pub fn push_state<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(json) = serde_json::to_string(&desktop_state(window)) else {
        return;
    };
    let _ = window.eval(format!(
        "window.agentBoardDesktop && window.agentBoardDesktop.setState({json})"
    ));
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let Some(webview) = window.get_webview_window(window.label()) else {
        return;
    };
    match event {
        WindowEvent::Resized(_) => {
            let maximized = webview.is_maximized().unwrap_or(false);
            let state = state(&webview);
            let mut last = state.last_maximized.lock().unwrap();
            if *last != maximized {
                *last = maximized;
                drop(last);
                push_state(&webview);
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let state = state(&webview);
            let mut layout = state.layout.lock().unwrap();
            let maximized = webview.is_maximized().unwrap_or(false);
            if !layout.compact_mode {
                layout.normal_maximized = maximized;
            }
            if !maximized {
                if let Some(rect) = current_rect(&webview) {
                    if layout.compact_mode {
                        layout.compact = Some(rect);
                    } else {
                        layout.normal = Some(rect);
                    }
                }
            }
            save(&state, &layout);
        }
        _ => {}
    }
}

fn current_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, rect: Rect) {
    let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
}

/// The saved rect, if it still lands on a connected monitor.
fn on_screen<R: Runtime>(window: &WebviewWindow<R>, rect: Option<Rect>) -> Option<Rect> {
    let rect = rect?;
    let monitors = window.available_monitors().ok()?;
    let visible = monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = i64::from(rect.x).max(i64::from(area.position.x));
        let top = i64::from(rect.y).max(i64::from(area.position.y));
        let right = (i64::from(rect.x) + i64::from(rect.width))
            .min(i64::from(area.position.x) + i64::from(area.size.width));
        let bottom = (i64::from(rect.y) + i64::from(rect.height))
            .min(i64::from(area.position.y) + i64::from(area.size.height));
        right - left >= MIN_VISIBLE && bottom - top >= MIN_VISIBLE
    });
    visible.then_some(rect)
}

/// Bottom-right corner of the monitor the window is on.
fn default_compact<R: Runtime>(window: &WebviewWindow<R>) -> Rect {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Rect {
            x: 100,
            y: 100,
            width: COMPACT_SIZE.0 as u32,
            height: COMPACT_SIZE.1 as u32,
        };
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = (COMPACT_SIZE.0 * scale) as u32;
    let height = (COMPACT_SIZE.1 * scale) as u32;
    let margin = (COMPACT_MARGIN * scale) as i32;
    Rect {
        x: area.position.x + area.size.width as i32 - width as i32 - margin,
        y: area.position.y + area.size.height as i32 - height as i32 - margin,
        width,
        height,
    }
}
