use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{DirEntry, FileEntry, ImageMeta};
use tauri::{AppHandle, Manager as _, State};

use crate::services::thumbnails::ThumbnailService;

#[tauri::command]
#[specta::specta]
pub fn scan_folder(app: AppHandle, path: PathBuf) -> Result<Vec<FileEntry>, String> {
    // Let the webview load originals from this folder via the asset protocol.
    app.asset_protocol_scope()
        .allow_directory(&path, false)
        .map_err(|e| format!("failed to extend asset scope: {e}"))?;
    imgvwr_core::scan_dir(&path).map_err(|e| format!("failed to scan {}: {e}", path.display()))
}

#[tauri::command]
#[specta::specta]
pub fn list_subdirs(path: PathBuf) -> Result<Vec<DirEntry>, String> {
    imgvwr_core::list_subdirs(&path)
        .map_err(|e| format!("failed to list {}: {e}", path.display()))
}

/// Count images per folder off the main thread, emitting one event per
/// result — cloud-backed folders (Dropbox, iCloud) can take seconds each,
/// so this must never block the tree display.
#[tauri::command]
#[specta::specta]
pub fn request_dir_counts(app: AppHandle, paths: Vec<String>) {
    std::thread::spawn(move || {
        use tauri_specta::Event as _;
        for path in paths {
            let image_count = imgvwr_core::scan::count_images(std::path::Path::new(&path));
            let _ = crate::events::DirCountReady { path, image_count }.emit(&app);
        }
    });
}

#[tauri::command]
#[specta::specta]
pub fn get_metadata(path: PathBuf) -> Result<ImageMeta, String> {
    imgvwr_core::read_meta(&path)
        .map_err(|e| format!("failed to read metadata of {}: {e}", path.display()))
}

#[tauri::command]
#[specta::specta]
pub fn new_epoch(service: State<'_, Arc<ThumbnailService>>) -> u64 {
    service.bump_epoch()
}

#[tauri::command]
#[specta::specta]
pub fn request_thumbnails(
    app: AppHandle,
    service: State<'_, Arc<ThumbnailService>>,
    paths: Vec<String>,
    epoch: u64,
) {
    service.request(&app, paths, epoch);
}
