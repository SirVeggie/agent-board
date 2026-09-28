//! Board shortcuts for every frame, including embedded sites.
//!
//! A cross-origin embed keeps its key events to itself, so neither the board page nor its
//! injected key script ever sees them. WebView2 raises AcceleratorKeyPressed for the whole
//! webview before any frame does, so the shortcuts are caught here instead.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Profile2, ICoreWebView2_13,
    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, COREWEBVIEW2_KEY_EVENT_KIND,
    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use webview2_com::{
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    ClearBrowsingDataCompletedHandler,
};
use windows::core::{w, Interface};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_F5, VK_MENU, VK_SHIFT};

use crate::layout;

enum Shortcut {
    /// Ctrl+Shift+M
    Compact,
    /// Board actions the page runs through `window.agentBoardShortcut`. Ctrl+Z stays with the
    /// page: an embed's text field needs its own undo, and board frames already forward it.
    /// Ctrl+Shift+T reopens without that caveat.
    Board(&'static str),
    /// F5 / Ctrl+R: drop WebView2's HTTP cache, then reload, so embedded sites are not stale.
    Reload,
}

const VK_TAB: u32 = 0x09;

fn shortcut_for(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<Shortcut> {
    if alt {
        return None;
    }
    if key == u32::from(VK_F5.0) {
        return Some(Shortcut::Reload);
    }
    if !ctrl {
        return None;
    }
    if key == VK_TAB {
        return Some(Shortcut::Board(if shift { "prev-tab" } else { "next-tab" }));
    }
    match (u8::try_from(key).ok()?, shift) {
        (b'M', true) => Some(Shortcut::Compact),
        (b'T', true) => Some(Shortcut::Board("reopen")),
        (b'D', false) => Some(Shortcut::Board("palette")),
        (b'S', false) => Some(Shortcut::Board("download")),
        (b'H', false) => Some(Shortcut::Board("help")),
        (b'W', false) => Some(Shortcut::Board("close-tab")),
        (b'R', false | true) => Some(Shortcut::Reload),
        _ => None,
    }
}

/// Holding Ctrl+Tab keeps cycling, like a browser. Everything else fires once per press.
fn repeats(shortcut: &Shortcut) -> bool {
    matches!(shortcut, Shortcut::Board("next-tab" | "prev-tab"))
}

fn pressed(key: u16) -> bool {
    unsafe { GetKeyState(key as i32) < 0 }
}

/// Drop the HTTP cache (disk + memory), then reload. A plain Reload reuses cached embed HTML.
unsafe fn reload_dropping_http_cache(controller: &ICoreWebView2Controller) {
    let Ok(core) = controller.CoreWebView2() else {
        return;
    };
    if drop_http_cache_then_reload(core.clone()).is_err() {
        let _ = core.Reload();
    }
}

unsafe fn drop_http_cache_then_reload(core: ICoreWebView2) -> windows::core::Result<()> {
    let after_disk = core.clone();
    let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |_| {
        unsafe {
            if clear_memory_cache_then_reload(after_disk.clone()).is_err() {
                let _ = after_disk.Reload();
            }
        }
        Ok(())
    }));
    core.cast::<ICoreWebView2_13>()?
        .Profile()?
        .cast::<ICoreWebView2Profile2>()?
        .ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)
}

unsafe fn clear_memory_cache_then_reload(core: ICoreWebView2) -> windows::core::Result<()> {
    let to_reload = core.clone();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| {
        unsafe {
            let _ = to_reload.Reload();
        }
        Ok(())
    }));
    core.CallDevToolsProtocolMethod(w!("Network.clearBrowserCache"), w!("{}"), &handler)
}

pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let for_keys = controller.clone();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                return Ok(());
            }
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            let Some(shortcut) = shortcut_for(key, pressed(VK_CONTROL.0), pressed(VK_SHIFT.0), pressed(VK_MENU.0))
            else {
                return Ok(());
            };
            args.SetHandled(true)?;
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            if status.WasKeyDown.as_bool() && !repeats(&shortcut) {
                return Ok(());
            }
            match shortcut {
                Shortcut::Reload => reload_dropping_http_cache(&for_keys),
                Shortcut::Compact => {
                    let window = target.clone();
                    // Leave the WebView2 callback before touching the window.
                    std::thread::spawn(move || layout::toggle_compact(&window));
                }
                Shortcut::Board(action) => {
                    let window = target.clone();
                    std::thread::spawn(move || {
                        let _ = window.eval(format!(
                            "window.agentBoardShortcut && window.agentBoardShortcut({action:?})"
                        ));
                    });
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
    });
}
