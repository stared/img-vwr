use imgvwr_core::{FileEntry, ImageMeta};
use serde::{Deserialize, Serialize};

/// A slice of an in-progress folder scan. Batches stream in walk order as
/// the tree is traversed — cloud-backed folders can take seconds to walk,
/// so the gallery fills progressively; `done` marks the final batch.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatch {
    pub entries: Vec<FileEntry>,
    pub epoch: u64,
    pub done: bool,
}

/// The open folder, re-read after something changed on disk.
///
/// The whole list rather than a diff: the watcher reports what a scan found,
/// and the frontend compares it with what it is showing. That one comparison
/// covers files appearing, disappearing, being renamed, and being rewritten —
/// all of which a diff computed from OS events would have to handle
/// separately, and would get wrong whenever events were coalesced or dropped.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FolderChanged {
    pub entries: Vec<FileEntry>,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailReady {
    pub path: String,
    /// Absolute path of the cached WebP (or the original file when no codec
    /// matched and the webview should decode it natively).
    pub cache_file: String,
    pub epoch: u64,
}

/// Direct image count of one folder, computed in the background. Keyed by
/// absolute path, so it is never stale — no epoch needed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct DirCountReady {
    pub path: String,
    pub image_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailFailed {
    pub path: String,
    pub error: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MetaEntry {
    pub path: String,
    pub meta: ImageMeta,
}

/// A batch of per-image metadata read in the background for the stats panel.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MetaBatchReady {
    pub items: Vec<MetaEntry>,
    pub epoch: u64,
}

/// Lifecycle of the user-selected embedding model:
/// "downloading" → "loading" → "ready", or "error".
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    pub model_id: String,
    pub phase: String,
    pub error: Option<String>,
}

/// Progress of a background indexing pass over the current collection.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProgress {
    pub done: u32,
    pub total: u32,
    pub epoch: u64,
}

/// Progress of a background face-detection pass over the current collection.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FacesProgress {
    pub done: u32,
    pub total: u32,
    pub epoch: u64,
}
