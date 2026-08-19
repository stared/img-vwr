use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{DirEntry, FileEntry, ImageMeta};
use imgvwr_embed::EmbedModelInfo;
use serde::Serialize;
use tauri::{AppHandle, Manager as _, State};

use std::collections::HashMap;

use crate::services::develop::{DevelopFrame, DevelopService, DevelopState};
use crate::services::embeddings::EmbeddingService;
use crate::services::export::{ExportJob, ExportPlan, Exported};
use crate::services::faces::{FaceService, PersonCluster};
use crate::services::files::TrashOutcome;
use crate::services::labels::{ImageLabels, LabelService};
use crate::services::thumbnails::ThumbnailService;
use crate::services::watcher::WatchService;
use imgvwr_core::Region;
use imgvwr_develop::{DevelopSettings, Overlay, Preset};

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

#[tauri::command]
#[specta::specta]
pub fn get_metadata(path: PathBuf) -> Result<ImageMeta, String> {
    read_meta_composed(&path)
        .map_err(|e| format!("failed to read metadata of {}: {e}", path.display()))
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

#[tauri::command]
#[specta::specta]
pub fn embedding_models(service: State<'_, Arc<EmbeddingService>>) -> Vec<EmbedModelInfo> {
    service.models()
}

/// Downloads on first use; progress arrives as `embedding-status` events.
#[tauri::command]
#[specta::specta]
pub fn embedding_select(
    app: AppHandle,
    service: State<'_, Arc<EmbeddingService>>,
    model_id: String,
) {
    service.select(&app, model_id);
}

/// Progress arrives as `embedding-progress` events.
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

/// scores[i][d-1] compares paths[i] with paths[i-d]; null until indexed — never computes vectors itself.
#[tauri::command]
#[specta::specta]
pub async fn embedding_banded_scores(
    service: State<'_, Arc<EmbeddingService>>,
    paths: Vec<String>,
    band: u32,
) -> Result<Vec<Vec<Option<f32>>>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.banded_scores(&paths, band as usize))
        .await
        .map_err(|e| e.to_string())?
}

/// Progress arrives as `faces-progress` events.
#[tauri::command]
#[specta::specta]
pub fn faces_index(
    app: AppHandle,
    service: State<'_, Arc<FaceService>>,
    paths: Vec<String>,
    epoch: u64,
) {
    use tauri_specta::Event as _;
    let service = Arc::clone(service.inner());
    std::thread::spawn(move || {
        service.index(&paths, |done, total| {
            let _ = crate::events::FacesProgress { done, total, epoch }.emit(&app);
        });
    });
}

/// Also propagates identity onto near-identical faceless photos.
#[tauri::command]
#[specta::specta]
pub async fn faces_people(
    faces: State<'_, Arc<FaceService>>,
    embeddings: State<'_, Arc<EmbeddingService>>,
    paths: Vec<String>,
    threshold: f32,
    merge: f32,
    propagate: f32,
) -> Result<Vec<PersonCluster>, String> {
    let faces = Arc::clone(faces.inner());
    let embeddings = Arc::clone(embeddings.inner());
    tauri::async_runtime::spawn_blocking(move || {
        faces.people(&embeddings, &paths, threshold, merge, propagate)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An empty name un-names; naming two fragments alike merges them on the next clustering.
#[tauri::command]
#[specta::specta]
pub fn faces_rename(
    faces: State<'_, Arc<FaceService>>,
    cluster_id: String,
    name: String,
    merge: f32,
) -> Result<(), String> {
    faces.rename(&cluster_id, &name, merge)
}

#[tauri::command]
#[specta::specta]
pub fn faces_names(faces: State<'_, Arc<FaceService>>) -> Result<Vec<String>, String> {
    faces.known_names()
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

// Label writes answer for every path given, so the frontend can install the result as-is.

#[tauri::command]
#[specta::specta]
pub async fn labels_set_stars(
    service: State<'_, Arc<LabelService>>,
    paths: Vec<String>,
    stars: Option<u8>,
) -> Result<HashMap<String, ImageLabels>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.set_stars(&paths, stars))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn labels_toggle_tag(
    service: State<'_, Arc<LabelService>>,
    paths: Vec<String>,
    tag: String,
) -> Result<HashMap<String, ImageLabels>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.toggle_tag(&paths, &tag))
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

#[tauri::command]
#[specta::specta]
pub async fn develop_state(
    service: State<'_, Arc<DevelopService>>,
    path: String,
) -> Result<DevelopState, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.state(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Fetched rather than duplicated in TypeScript: the preset numbers live only in `imgvwr_develop`.
#[tauri::command]
#[specta::specta]
pub async fn develop_presets() -> Result<Vec<Preset>, String> {
    Ok(imgvwr_develop::presets())
}

/// Returns stops, measured from the recorded light rather than the current preview.
#[tauri::command]
#[specta::specta]
pub async fn develop_auto_exposure(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
) -> Result<f32, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.auto_exposure(&path, &settings))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn develop_focus_point(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
) -> Result<[f32; 2], String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.focus_point(&path, &settings))
        .await
        .map_err(|e| e.to_string())?
}

/// Pixels are fetched separately over the `develop:` protocol using the returned token.
#[tauri::command]
#[specta::specta]
pub async fn develop_render(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
    max_edge: u32,
    overlay: Overlay,
    region: RegionArg,
) -> Result<DevelopFrame, String> {
    let service = Arc::clone(service.inner());
    let region = Region {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
    };
    tauri::async_runtime::spawn_blocking(move || {
        service.render(&path, &settings, max_edge, overlay, region)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn develop_pick_white_balance(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    x: f32,
    y: f32,
    settings: DevelopSettings,
) -> Result<imgvwr_core::WhiteBalance, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.pick_white_balance(&path, x, y, &settings))
        .await
        .map_err(|e| e.to_string())?
}

/// Mirrors `imgvwr_core::Region`, which deliberately carries no serde attributes.
#[derive(Debug, Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RegionArg {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[tauri::command]
#[specta::specta]
pub async fn develop_save(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
) -> Result<(), String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.save_settings(&path, &settings))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn develop_reset(
    service: State<'_, Arc<DevelopService>>,
    path: String,
) -> Result<DevelopState, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.clear_settings(&path)?;
        service.state(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn develop_edited_paths(
    service: State<'_, Arc<DevelopService>>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.edited_paths(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Whole-frame crops are omitted: only crops that actually take something are returned.
#[tauri::command]
#[specta::specta]
pub async fn develop_crops(
    service: State<'_, Arc<DevelopService>>,
    paths: Vec<String>,
) -> Result<HashMap<String, imgvwr_develop::Crop>, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.crops(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes nothing: the merge stays virtual until Export.
#[tauri::command]
#[specta::specta]
pub fn develop_set_fusions(
    service: State<'_, Arc<DevelopService>>,
    fusions: HashMap<String, crate::services::develop::FusionRecipe>,
) {
    service.set_fusions(fusions);
}

/// One file per call, not a batch: the UI owns progress, cancellation and order.
#[tauri::command]
#[specta::specta]
pub async fn develop_export(
    service: State<'_, Arc<DevelopService>>,
    job: ExportJob,
    plan: ExportPlan,
) -> Result<Exported, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.export(&job, &plan))
        .await
        .map_err(|e| e.to_string())?
}
