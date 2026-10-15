//! Folder-level commands: scanning, metadata, thumbnails, trash and clipboard; feature and service commands live beside their code.

use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{DirEntry, FileEntry, ImageMeta};
use tauri::{AppHandle, Manager as _, State};

use crate::services::files::TrashOutcome;
use crate::services::thumbnails::ThumbnailService;
use crate::services::watcher::WatchService;

/// Entries arrive as `ScanBatch` events (last marked `done`), epoch-guarded so a newer scope cancels the walk.
#[tauri::command]
#[specta::specta]
pub async fn scan_folder(
    app: AppHandle,
    service: State<'_, Arc<ThumbnailService>>,
    watcher: State<'_, Arc<WatchService>>,
    path: PathBuf,
    recursive: bool,
    epoch: u64,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, recursive)
        .map_err(|e| format!("failed to extend asset scope: {e}"))?;
    // Watch before the walk, not after: changes during a seconds-long scan must not be missed.
    watcher.watch(&app, path.clone(), recursive, epoch);
    let service = Arc::clone(&service);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_specta::Event as _;
        const FIRST_BATCH: usize = 64;
        const BATCH: usize = 512;
        const MAX_LATENCY: std::time::Duration = std::time::Duration::from_millis(200);
        let mut batch: Vec<FileEntry> = Vec::new();
        let mut sent_any = false;
        let mut last_flush = std::time::Instant::now();
        imgvwr_core::scan_stream(&path, recursive, &mut |entry| {
            if service.is_stale(epoch) {
                return false;
            }
            batch.push(entry);
            let full = batch.len() >= if sent_any { BATCH } else { FIRST_BATCH };
            if full || last_flush.elapsed() >= MAX_LATENCY {
                let entries = std::mem::take(&mut batch);
                let _ = crate::events::ScanBatch { entries, epoch, done: false }.emit(&app);
                sent_any = true;
                last_flush = std::time::Instant::now();
            }
            true
        })
        .map_err(|e| format!("failed to scan {}: {e}", path.display()))?;
        if !service.is_stale(epoch) {
            let _ = crate::events::ScanBatch { entries: batch, epoch, done: true }.emit(&app);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn list_subdirs(path: PathBuf) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        imgvwr_core::list_subdirs(&path)
            .map_err(|e| format!("failed to list {}: {e}", path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mirrors the frontend's recent folders into File › Open Recent.
#[tauri::command]
#[specta::specta]
pub fn set_recent_folders(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    crate::menu::set_recent(&app, &paths).map_err(|e| e.to_string())
}

/// Results arrive as `DirCountReady` events, one per folder.
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

/// Results arrive as `MetaBatchReady` events, epoch-guarded.
#[tauri::command]
#[specta::specta]
pub fn request_meta(
    app: AppHandle,
    service: State<'_, Arc<ThumbnailService>>,
    paths: Vec<String>,
    epoch: u64,
) {
    let service = Arc::clone(&service);
    std::thread::spawn(move || {
        use tauri_specta::Event as _;
        const BATCH: usize = 32;
        let mut items = Vec::with_capacity(BATCH);
        for path in paths {
            if service.is_stale(epoch) {
                return;
            }
            if let Ok(meta) = read_meta_composed(std::path::Path::new(&path)) {
                items.push(crate::events::MetaEntry { path, meta });
            }
            if items.len() >= BATCH {
                let batch = std::mem::take(&mut items);
                let _ = crate::events::MetaBatchReady { items: batch, epoch }.emit(&app);
            }
        }
        if !items.is_empty() {
            let _ = crate::events::MetaBatchReady { items, epoch }.emit(&app);
        }
    });
}

/// Raw dimensions come from the raw plugin: no Rust decoder can measure a raw file.
fn read_meta_composed(path: &std::path::Path) -> std::io::Result<ImageMeta> {
    let mut meta = imgvwr_core::read_meta(path)?;
    if meta.width.is_none() {
        if let Some((width, height)) = imgvwr_raw::raw_dimensions(path) {
            meta.width = Some(width);
            meta.height = Some(height);
        }
    }
    Ok(meta)
}

/// Never prompts (confirmation is the frontend's job) and never reports more as trashed than actually went.
#[tauri::command]
#[specta::specta]
pub async fn delete_files(paths: Vec<String>) -> Result<TrashOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::files::to_trash(paths))
        .await
        .map_err(|e| e.to_string())
}

/// Copies file references, not pixel data — a paste receives the files themselves.
#[tauri::command]
#[specta::specta]
pub async fn copy_files(paths: Vec<String>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::files::to_clipboard(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Also stops the watcher: a remote scope never re-watches and would otherwise leak one.
#[tauri::command]
#[specta::specta]
pub fn new_epoch(
    service: State<'_, Arc<ThumbnailService>>,
    watcher: State<'_, Arc<WatchService>>,
) -> u64 {
    watcher.stop();
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

/// Computed from the cached thumbnail, not the original.
#[tauri::command]
#[specta::specta]
pub async fn image_stats(
    thumbs: State<'_, Arc<ThumbnailService>>,
    path: String,
) -> Result<imgvwr_core::ImageStats, String> {
    let thumbs = Arc::clone(thumbs.inner());
    tauri::async_runtime::spawn_blocking(move || thumbs.image_stats(&path))
        .await
        .map_err(|e| e.to_string())?
}

