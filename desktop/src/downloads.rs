//! Ask for a destination before the webview writes an export or other download.

use tauri::{webview::DownloadEvent, Webview};

pub fn handle(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let DownloadEvent::Requested { destination, .. } = event else {
        return true;
    };

    let mut dialog = rfd::FileDialog::new()
        .set_parent(&webview.window())
        .set_title("Save file");
    if let Some(name) = destination.file_name() {
        dialog = dialog.set_file_name(name.to_string_lossy());
    }
    if let Some(directory) = destination.parent() {
        dialog = dialog.set_directory(directory);
    }

    match dialog.save_file() {
        Some(path) => {
            *destination = path;
            true
        }
        // Cancel the download too: never fall back to silently saving in Downloads.
        None => false,
    }
}
