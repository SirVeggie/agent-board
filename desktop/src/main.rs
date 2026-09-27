//! Agent Board desktop: a native window over the same daemon and UI the browser uses.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod board;
#[cfg(windows)]
mod keys;
mod layout;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";

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
        _ => return Err(format!("Unknown desktop setting: {name}")),
    }
    Ok(layout::desktop_state(&window))
}

fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn select_tab(window: &WebviewWindow, tab: &str) {
    let _ = window.eval(format!("location.hash = {tab:?}"));
}

fn fail(message: &str) -> ! {
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        MessageBoxW(None, &HSTRING::from(message), &HSTRING::from("Agent Board"), MB_OK | MB_ICONERROR);
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
    std::process::exit(1);
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
        .invoke_handler(tauri::generate_handler![desktop_state, window_action, set_desktop_setting])
        .on_window_event(layout::on_window_event)
        .setup(move |app| {
            if let Err(message) = board::ensure_daemon() {
                fail(&message);
            }
            let open_from_agents = board::read_registration().is_none_or(|registration| registration.open_from_agents);
            board::write_registration(open_from_agents);

            let base = board::base_url();
            // Only the board's own origin gets IPC. Tab pages (127.0.0.2) and embedded sites do not.
            app.add_capability(
                CapabilityBuilder::new("board")
                    .remote(format!("{base}/*"))
                    .window(MAIN)
                    .permission("core:window:allow-start-dragging")
                    .permission("core:window:allow-internal-toggle-maximize")
                    .permission("allow-desktop-state")
                    .permission("allow-window-action")
                    .permission("allow-set-desktop-setting"),
            )?;
            app.manage(layout::load(app.handle()));

            let mut url: Url = format!("{base}/").parse()?;
            if let Some(tab) = board::tab_from_args(&args) {
                url.set_fragment(Some(&tab));
            }
            let origin = url.origin();
            let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
                .title("Agent Board")
                .inner_size(1280.0, 800.0)
                .min_inner_size(320.0, 240.0)
                .decorations(true)
                .visible(false)
                .on_new_window(|url, _| {
                    board::open_external(url.as_str());
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    if url.origin() == origin {
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
            keys::install(&window);
            focus(&window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent Board");
}
