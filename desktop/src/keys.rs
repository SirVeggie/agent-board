//! Board shortcuts for every frame, including embedded sites.
//!
//! A cross-origin embed keeps its key events to itself, so neither the board page nor its
//! injected key script ever sees them. WebView2 raises AcceleratorKeyPressed for the whole
//! webview before any frame does, so the shortcuts are caught here instead.

use tauri::WebviewWindow;
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

use crate::layout;

enum Shortcut {
    /// Ctrl+Shift+M
    Compact,
    /// Board actions the page runs through `window.agentBoardShortcut`. Ctrl+Z stays with the
    /// page: an embed's text field needs its own undo, and board frames already forward it.
    /// Ctrl+Shift+T reopens without that caveat.
    Board(&'static str),
}

const VK_TAB: u32 = 0x09;

fn shortcut_for(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<Shortcut> {
    if !ctrl || alt {
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

pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
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
            let window = target.clone();
            // Leave the WebView2 callback before touching the window.
            std::thread::spawn(move || match shortcut {
                Shortcut::Compact => layout::toggle_compact(&window),
                Shortcut::Board(action) => {
                    let _ = window.eval(format!(
                        "window.agentBoardShortcut && window.agentBoardShortcut({action:?})"
                    ));
                }
            });
            Ok(())
        }));
        let mut token = 0i64;
        let _ = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token);
    });
}
