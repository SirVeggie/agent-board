fn main() {
    println!("cargo:rerun-if-changed=src");
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_secs();
    println!("cargo:rustc-env=SCRIBE_DESKTOP_BUILT_AT={built_at}");
    println!("cargo:rerun-if-changed=../public/tooltip.js");
    let tooltip = std::fs::read("../public/tooltip.js").expect("failed to read shared tooltips");
    if std::fs::read("splash/tooltip.js").ok().as_deref() != Some(tooltip.as_slice()) {
        std::fs::write("splash/tooltip.js", tooltip)
            .expect("failed to write shared tooltips into desktop assets");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_state", "window_action", "set_desktop_setting", "daemon_status", "child_window", "key_focus"]),
    ))
    .expect("failed to run tauri-build");
}
