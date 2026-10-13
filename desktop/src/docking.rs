//! Track a native title-bar drag while the OS owns the pointer. Coordinates are shares of the
//! main client area, so the renderer can map them to CSS pixels at any DPI or webview zoom.

#[cfg(not(windows))]
pub fn watch(_: &tauri::WebviewWindow) {}

#[cfg(windows)]
pub fn watch(child: &tauri::WebviewWindow) {
    use tauri::Manager;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON, VK_SHIFT,
    };
    if !child.label().starts_with(crate::CHILD_PREFIX)
        || !child
            .state::<crate::layout::LayoutState>()
            .dock_child_windows()
    {
        return;
    }
    let Some(id) = child.url().ok().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "popout")
            .map(|(_, id)| id.into_owned())
    }) else {
        return;
    };
    // The standalone chat has no page target to put in a split.
    if id == "agent-chat" {
        return;
    }
    let Some(main) = child.get_webview_window(crate::MAIN) else {
        return;
    };
    let start = child.outer_position().ok();
    let child = child.clone();
    std::thread::spawn(move || {
        let mut moved = false;
        let mut cancelled = false;
        for _ in 0..7500 {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            cancelled |= unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } < 0;
            cancelled |= unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } < 0;
            let Ok(position) = child.outer_position() else {
                break;
            };
            moved |= start.zip(Some(position)).is_some_and(|(a, b)| {
                (a.x as i64 - b.x as i64).abs() + (a.y as i64 - b.y as i64).abs() > 4
            });
            let enabled = moved
                && !cancelled
                && main.is_visible().unwrap_or(false)
                && !main.is_minimized().unwrap_or(true)
                && main
                    .state::<crate::layout::LayoutState>()
                    .dock_child_windows()
                && unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) } >= 0;
            let point = main
                .cursor_position()
                .ok()
                .zip(main.inner_position().ok())
                .zip(main.inner_size().ok())
                .map(|((cursor, origin), size)| {
                    (
                        (cursor.x - origin.x as f64) / size.width.max(1) as f64,
                        (cursor.y - origin.y as f64) / size.height.max(1) as f64,
                    )
                });
            let (x, y) = point.unwrap_or((-1.0, -1.0));
            let payload = serde_json::json!({ "id": id, "x": x, "y": y,
                "enabled": enabled, "done": !down });
            if main.eval(format!("window.dispatchEvent(new CustomEvent('scribe:child-drag', {{detail:{payload}}}))")).is_err() {
                break;
            }
            if !down {
                return;
            }
        }
        let payload = serde_json::json!({ "id": id, "enabled": false, "done": true });
        let _ = main.eval(format!(
            "window.dispatchEvent(new CustomEvent('scribe:child-drag', {{detail:{payload}}}))"
        ));
    });
}
