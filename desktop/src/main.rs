//! Scribe desktop: a native window over the same daemon and UI the browser uses.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod board;
#[cfg(windows)]
mod embeds;
#[cfg(windows)]
mod keys;
mod layout;
mod startup;
mod tray;

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";

/// Why the daemon last failed to start, for the offline page.
#[derive(Default)]
struct DaemonError(Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    board: String,
    running: bool,
    error: Option<String>,
}

#[tauri::command]
async fn desktop_state(window: WebviewWindow) -> layout::DesktopState {
    layout::desktop_state(&window)
}

#[tauri::command]
async fn window_action(window: WebviewWindow, action: String) -> Result<(), String> {
    let result = match action.as_str() {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "toggle-compact" => {
            layout::toggle_compact(&window);
            Ok(())
        }
        // The board page lost the daemon. Swap it for the offline page, which comes back when it can.
        "daemon-offline" => {
            if board::is_running() {
                return Ok(());
            }
            let mut url = offline_url();
            url.set_fragment(window.url().ok().as_ref().and_then(Url::fragment));
            window.navigate(url)
        }
        _ => return Err(format!("Unknown window action: {action}")),
    };
    result.map_err(|err| err.to_string())
}

#[tauri::command]
async fn set_desktop_setting(
    window: WebviewWindow,
    name: String,
    value: bool,
) -> Result<layout::DesktopState, String> {
    match name.as_str() {
        "compactOnTop" => layout::set_compact_on_top(&window, value),
        "openFromAgents" => board::write_registration(value),
        "closeToTray" => {
            layout::set_close_to_tray(&window, value);
            tray::set_enabled(window.app_handle(), value);
        }
        "launchAtStartup" => startup::set_enabled(value)?,
        _ => return Err(format!("Unknown desktop setting: {name}")),
    }
    Ok(layout::desktop_state(&window))
}

/// For the offline page: whether the daemon answers, optionally after trying to start it.
#[tauri::command]
async fn daemon_status(app: AppHandle, start: bool) -> DaemonStatus {
    let last_error = app.state::<DaemonError>();
    if start {
        let result = tauri::async_runtime::spawn_blocking(board::ensure_daemon)
            .await
            .unwrap_or_else(|err| Err(err.to_string()));
        *last_error.0.lock().unwrap() = result.err();
    }
    let error = last_error.0.lock().unwrap().clone();
    DaemonStatus {
        board: format!("{}/", board::base_url()),
        running: board::is_running(),
        error,
    }
}

/// The bundled page (splash/index.html) shown while the daemon is down, where Tauri serves it.
fn offline_url() -> Url {
    let origin = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
    format!("{origin}/index.html").parse().expect("valid offline page URL")
}

/// Show the window, from the taskbar, the tray, or nowhere yet.
fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    layout::push_state(window);
}

fn select_tab(window: &WebviewWindow, tab: &str) {
    let _ = window.eval(format!("location.hash = {tab:?}"));
}

fn quit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        layout::remember(&window);
    }
    app.exit(0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN) {
                focus(&window);
                if let Some(tab) = board::tab_from_args(&argv) {
                    select_tab(&window, &tab);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            window_action,
            set_desktop_setting,
            daemon_status
        ])
        .on_window_event(layout::on_window_event)
        .setup(move |app| {
            let daemon_error = board::ensure_daemon().err();
            let daemon_up = daemon_error.is_none();
            app.manage(DaemonError(Mutex::new(daemon_error)));
            let open_from_agents = board::read_registration().is_none_or(|registration| registration.open_from_agents);
            board::write_registration(open_from_agents);

            let base = board::base_url();
            // Only the board's own origin gets IPC. Tab pages (127.0.0.2) and embedded sites do not.
            app.add_capability(
                CapabilityBuilder::new("scribe")
                    .remote(format!("{base}/*"))
                    .window(MAIN)
                    .permission("core:window:allow-start-dragging")
                    .permission("core:window:allow-internal-toggle-maximize")
                    .permission("allow-desktop-state")
                    .permission("allow-window-action")
                    .permission("allow-set-desktop-setting")
                    .permission("allow-daemon-status"),
            )?;
            let layout = layout::load(app.handle());
            let close_to_tray = layout.close_to_tray();
            app.manage(layout);
            tray::set_enabled(app.handle(), close_to_tray);
            startup::refresh();

            let board_url: Url = format!("{base}/").parse()?;
            let board_origin = board_url.origin();
            let offline_origin = offline_url().origin();
            let mut url = if daemon_up { board_url } else { offline_url() };
            if let Some(tab) = board::tab_from_args(&args) {
                url.set_fragment(Some(&tab));
            }
            let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
                .title("Scribe")
                .inner_size(1280.0, 800.0)
                .min_inner_size(320.0, 240.0)
                .decorations(true)
                .visible(false)
                .on_new_window(|url, _| {
                    board::open_external(url.as_str());
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    if url.origin() == board_origin || url.origin() == offline_origin {
                        return true;
                    }
                    board::open_external(url.as_str());
                    false
                })
                .build()?;
            // Created with decorations and stripped here: a window built undecorated comes out a
            // caption-height taller than asked, and that extra height leaks into the saved layout.
            window.set_decorations(false)?;
            layout::apply_initial(&window);
            #[cfg(windows)]
            {
                keys::install(&window);
                embeds::install(&window, board::port());
            }
            // Started with the OS and kept in the tray: stay there until opened.
            let autostart = args.iter().any(|arg| arg == startup::ARG);
            if !(autostart && close_to_tray) {
                focus(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}
