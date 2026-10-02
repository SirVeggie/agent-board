//! Launch at sign-in: a `Run` entry in the user's registry that starts this exe with `--autostart`.

pub const ARG: &str = "--autostart";

pub fn is_enabled() -> bool {
    imp::is_enabled()
}

pub fn set_enabled(on: bool) -> Result<(), String> {
    imp::set_enabled(on)
}

/// Point an existing entry at this exe, so a copy installed somewhere else keeps starting.
/// An entry left under the old "Agent Board" name moves to the current one.
/// Debug builds leave it alone: they come and go with `cargo clean`.
pub fn refresh() {
    if cfg!(debug_assertions) {
        return;
    }
    if imp::take_legacy() || is_enabled() {
        let _ = imp::set_enabled(true);
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_BINARY,
        RRF_RT_REG_SZ,
    };

    const RUN: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
    /// Task Manager's Startup tab keeps its own on/off switch for each Run entry here.
    const APPROVED: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
    const NAME: PCWSTR = w!("Scribe");
    /// The entry's name before the app was renamed to Scribe.
    const LEGACY_NAME: PCWSTR = w!("Agent Board");

    /// Remove an entry under the old name. True when it was there and switched on.
    pub fn take_legacy() -> bool {
        let exists =
            unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN, LEGACY_NAME, RRF_RT_REG_SZ, None, None, None) }.is_ok();
        if !exists {
            return false;
        }
        let on = approved_as(LEGACY_NAME);
        unsafe {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN, LEGACY_NAME);
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, APPROVED, LEGACY_NAME);
        }
        on
    }

    pub fn is_enabled() -> bool {
        let exists = unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN, NAME, RRF_RT_REG_SZ, None, None, None) }.is_ok();
        exists && approved()
    }

    /// No switch means on. Task Manager writes an odd first byte when it turns an entry off.
    fn approved() -> bool {
        approved_as(NAME)
    }

    fn approved_as(name: PCWSTR) -> bool {
        let mut bytes = [0u8; 12];
        let mut len = bytes.len() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                APPROVED,
                name,
                RRF_RT_REG_BINARY,
                None,
                Some(bytes.as_mut_ptr().cast()),
                Some(&mut len),
            )
        };
        !status.is_ok() || bytes[0] & 1 == 0
    }

    pub fn set_enabled(on: bool) -> Result<(), String> {
        // Turning it on here also clears a Task Manager "disabled", which would otherwise win.
        delete(APPROVED)?;
        if !on {
            return delete(RUN);
        }
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let command = format!("\"{}\" {}", exe.display(), super::ARG);
        let wide: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                RUN,
                NAME,
                REG_SZ.0,
                Some(wide.as_ptr().cast()),
                (wide.len() * 2) as u32,
            )
        };
        check(status)
    }

    fn delete(key: PCWSTR) -> Result<(), String> {
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key, NAME) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        check(status)
    }

    fn check(status: WIN32_ERROR) -> Result<(), String> {
        status.ok().map_err(|err| format!("Could not change the startup entry: {err}"))
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_enabled() -> bool {
        false
    }

    pub fn take_legacy() -> bool {
        false
    }

    pub fn set_enabled(_on: bool) -> Result<(), String> {
        Err("Launching at startup is only supported on Windows.".into())
    }
}
