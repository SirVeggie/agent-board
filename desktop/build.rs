fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_state", "window_action", "set_desktop_setting", "daemon_status"]),
    ))
    .expect("failed to run tauri-build");
}
