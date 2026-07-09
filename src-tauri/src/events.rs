use imgvwr_core::ImageMeta;
use serde::{Deserialize, Serialize};

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
