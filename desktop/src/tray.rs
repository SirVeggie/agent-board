//! The tray icon that holds the app while "close to tray" is on. It exists only while that setting does.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY: &str = "tray";

pub fn set_enabled(app: &AppHandle, on: bool) {
    if !on {
        if let Some(tray) = app.remove_tray_by_id(TRAY) {
            // Hide before dropping so the icon leaves the tray now, not on the next hover.
            let _ = tray.set_visible(false);
        }
        return;
    }
    if app.tray_by_id(TRAY).is_none() {
        let _ = build(app);
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("Scribe")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::MAIN) {
        crate::focus(&window);
    }
}
