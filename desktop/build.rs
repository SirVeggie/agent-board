fn main() {
    println!("cargo:rerun-if-changed=../public/tooltip.js");
    let tooltip = std::fs::read("../public/tooltip.js").expect("failed to read shared tooltips");
    if std::fs::read("splash/tooltip.js").ok().as_deref() != Some(tooltip.as_slice()) {
        std::fs::write("splash/tooltip.js", tooltip)
            .expect("failed to write shared tooltips into desktop assets");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_state", "window_action", "set_desktop_setting", "daemon_status"]),
    ))
    .expect("failed to run tauri-build");
}
