use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{DirEntry, FileEntry, ImageMeta};
use imgvwr_embed::EmbedModelInfo;
use serde::Serialize;
use tauri::{AppHandle, Manager as _, State};

use std::collections::HashMap;

use crate::services::develop::{DevelopFrame, DevelopService, DevelopState};
use crate::services::embeddings::EmbeddingService;
use crate::services::faces::{FaceService, PersonCluster};
use crate::services::files::TrashOutcome;
use crate::services::labels::{ImageLabels, LabelService};
use crate::services::thumbnails::ThumbnailService;
use crate::services::watcher::WatchService;
use imgvwr_core::Region;
use imgvwr_develop::{DevelopSettings, Overlay, Preset};

/// Run a streamed folder scan: entries arrive as `ScanBatch` events, the
/// last one marked `done`. Walking a big (or cloud-backed) tree can take
/// seconds, so nothing here may touch the main thread — the command is
/// async and the walk runs on the blocking pool, epoch-guarded so opening
/// another scope cancels it. The first batch is small for a fast first
/// paint. Resolves when the walk ends; an unreadable root rejects.
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
    // Let the webview load originals from this folder via the asset protocol.
    app.asset_protocol_scope()
        .allow_directory(&path, recursive)
        .map_err(|e| format!("failed to extend asset scope: {e}"))?;
    // Watch from the start of the walk, not the end: a card still copying is
    // exactly when a folder changes under you, and the scan can take seconds.
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

/// Async: listing a cloud-backed directory can block for seconds, and this
/// runs on every folder-tree navigation.
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

/// Metadata for one file, with raw dimensions filled in by the raw plugin.
///
/// No Rust decoder can measure a raw file, and `imgvwr-core` must not depend
/// on a platform plugin to find out — so the two are composed here, at the
/// layer that already knows about both.
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

/// Move photographs to the platform Trash, reporting on each one.
///
/// The frontend has already asked the user, and asks every time — this end
/// never prompts, never guesses which paths were meant, and never reports
/// more as gone than actually went. Async + `spawn_blocking` like every other
/// filesystem command: a slow volume must not freeze the window.
#[tauri::command]
#[specta::specta]
pub async fn delete_files(paths: Vec<String>) -> Result<TrashOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::files::to_trash(paths))
        .await
        .map_err(|e| e.to_string())
}

/// Put the selected photographs on the system clipboard as file references,
/// so a paste elsewhere — the Finder, a chat — receives the files themselves.
#[tauri::command]
#[specta::specta]
pub async fn copy_files(paths: Vec<String>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::files::to_clipboard(&paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Begin a new collection, invalidating everything in flight for the old one.
///
/// Also stops watching: every scope change goes through here, and a folder
/// nobody is looking at should not be reported on. A folder scope re-watches
/// a moment later in `scan_folder`; a remote source has no folder to watch,
/// which is exactly the case that would otherwise have leaked a watcher.
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

/// Similarity of each of `paths` to the few before it (scores[i][d-1]
/// describes paths[i] and paths[i-d]), from vectors already indexed; null
/// where a vector is not yet known. Scene detection calls this over whole
/// collections, which is exactly why it never computes vectors itself.
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

/// Detect faces over the collection in the background; progress arrives as
/// `faces-progress` events. Per-photo results are cached as sidecars, so a
/// repeat pass over an unchanged folder is a cache read.
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

/// Cluster every detected face of `paths` into people, propagating identity
/// onto near-identical faceless photos. Cheap to re-run: vectors and
/// detections are cached, so this is dot products and bookkeeping.
#[tauri::command]
#[specta::specta]
pub async fn faces_people(
    faces: State<'_, Arc<FaceService>>,
    embeddings: State<'_, Arc<EmbeddingService>>,
    paths: Vec<String>,
    threshold: f32,
    propagate: f32,
) -> Result<Vec<PersonCluster>, String> {
    let faces = Arc::clone(faces.inner());
    let embeddings = Arc::clone(embeddings.inner());
    tauri::async_runtime::spawn_blocking(move || {
        faces.people(&embeddings, &paths, threshold, propagate)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Per-image pixel statistics (histograms, color triangle) for the info
/// panel — computed from the cached thumbnail, off the main thread.
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

/* Writes take a list of paths because rating and tagging apply to the
 * selection, which can be the whole folder. Both answer for every path they
 * were given, so the frontend can install the result as it stands. */

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

/* Develop commands — thin adapters over DevelopService. Opening a raw file
 * and rendering it are both real compute, so every one of these is async +
 * spawn_blocking: a forward pass on the main thread freezes the window. */

/// Open an image for editing and report its size, camera white balance and
/// any stored edit. Slow on first call for a raw file (the decoder parses and
/// sets up demosaicing); every later render of the same image is cheap.
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

/// The named starting points an edit can be set to.
///
/// Synchronous work, but async like its neighbours so the frontend calls every
/// develop command the same way. Fetched rather than duplicated in TypeScript:
/// the numbers are measured against real files by the `match_camera` example
/// and there should be exactly one place they live.
#[tauri::command]
#[specta::specta]
pub async fn develop_presets() -> Result<Vec<Preset>, String> {
    Ok(imgvwr_develop::presets())
}

/// The exposure this image wants, in stops, measured from the light it
/// recorded rather than from the preview it currently produces.
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

/// Where this frame is sharpest — what the loupe points at before the user
/// has pointed it anywhere themselves.
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

/// Render a preview at `max_edge` under `settings`. The pixels are fetched
/// separately over the `develop:` protocol using the returned token; the
/// histogram of those same pixels comes back here.
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

/// Sample a point and report the white balance that renders it neutral —
/// the eyedropper. Runs off the main thread like every other develop call.
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

/// The wire form of a render region. Mirrors `imgvwr_core::Region`, which is
/// a pure-core type and deliberately carries no serialisation attributes.
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

/// Drop an image's edit so it counts as untouched again.
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

/// Which of these paths have a stored edit — for badging the gallery.
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

/// Develop at full resolution and write to `destination`, which the user
/// picked in a save dialog. Nothing is ever written beside the original.
#[tauri::command]
#[specta::specta]
pub async fn develop_export(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
    destination: String,
) -> Result<(), String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.export(&path, &settings, std::path::Path::new(&destination))
    })
    .await
    .map_err(|e| e.to_string())?
}
