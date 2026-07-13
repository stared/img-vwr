use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{DirEntry, FileEntry, ImageMeta};
use imgvwr_embed::EmbedModelInfo;
use serde::Serialize;
use tauri::{AppHandle, Manager as _, State};

use std::collections::HashMap;

use crate::services::embeddings::EmbeddingService;
use crate::services::labels::{ImageLabels, LabelService};
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

/// Read per-image metadata (dimensions, EXIF) for the stats panel off the
/// main thread, emitting batched events. Sequential on one thread — gentle
/// on cloud-backed folders — and epoch-guarded so a folder change stops it.
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
            if let Ok(meta) = imgvwr_core::read_meta(std::path::Path::new(&path)) {
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

/* Embedding commands — thin adapters over the embedding service, which is
 * itself a thin host around the imgvwr-embed plugin crate. */

#[tauri::command]
#[specta::specta]
pub fn embedding_models(service: State<'_, Arc<EmbeddingService>>) -> Vec<EmbedModelInfo> {
    service.models()
}

/// Download (first time) and activate a model; progress arrives as
/// `embedding-status` events.
#[tauri::command]
#[specta::specta]
pub fn embedding_select(
    app: AppHandle,
    service: State<'_, Arc<EmbeddingService>>,
    model_id: String,
) {
    service.select(&app, model_id);
}

/// Compute (or load from cache) one vector per image in the background;
/// progress arrives as `embedding-progress` events.
#[tauri::command]
#[specta::specta]
pub fn embedding_index(
    app: AppHandle,
    service: State<'_, Arc<EmbeddingService>>,
    thumbs: State<'_, Arc<ThumbnailService>>,
    paths: Vec<String>,
    epoch: u64,
) {
    service.index(&app, &thumbs, paths, epoch);
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimilarityScore {
    pub path: String,
    pub score: f32,
}

/* Ranking runs a model forward pass; async + spawn_blocking keeps it off
 * the main thread so the window never freezes while it computes. */

#[tauri::command]
#[specta::specta]
pub async fn embedding_rank_image(
    service: State<'_, Arc<EmbeddingService>>,
    anchor: String,
    paths: Vec<String>,
) -> Result<Vec<SimilarityScore>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let scores = service.rank_image(&anchor, &paths)?;
        Ok(scores
            .into_iter()
            .map(|(path, score)| SimilarityScore { path, score })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* Label commands — the app-local star/tag store. Reads can span thousands
 * of paths, so everything runs off the main thread like ranking does. */

#[tauri::command]
#[specta::specta]
pub async fn labels_for_paths(
    service: State<'_, Arc<LabelService>>,
    paths: Vec<String>,
) -> Result<HashMap<String, ImageLabels>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.for_paths(&paths))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn labels_set_stars(
    service: State<'_, Arc<LabelService>>,
    path: String,
    stars: Option<u8>,
) -> Result<ImageLabels, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.set_stars(&path, stars))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn labels_toggle_tag(
    service: State<'_, Arc<LabelService>>,
    path: String,
    tag: String,
) -> Result<ImageLabels, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.toggle_tag(&path, &tag))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn embedding_rank_text(
    service: State<'_, Arc<EmbeddingService>>,
    query: String,
    paths: Vec<String>,
) -> Result<Vec<SimilarityScore>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let scores = service.rank_text(&query, &paths)?;
        Ok(scores
            .into_iter()
            .map(|(path, score)| SimilarityScore { path, score })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
