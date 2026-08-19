use imgvwr_core::{FileEntry, ImageMeta};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatch {
    pub entries: Vec<FileEntry>,
    pub epoch: u64,
    pub done: bool,
}

/// The whole re-scanned list, not a diff: coalesced or dropped OS events make diffs wrong.
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
    /// The cached WebP — or the original file when no codec matched and the webview decodes natively.
    pub cache_file: String,
    pub epoch: u64,
}

/// Keyed by absolute path, so it is never stale — hence no epoch.
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MetaBatchReady {
    pub items: Vec<MetaEntry>,
    pub epoch: u64,
}

/// `phase` runs "downloading" → "loading" → "ready", or "error".
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    pub model_id: String,
    pub phase: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProgress {
    pub done: u32,
    pub total: u32,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FacesProgress {
    pub done: u32,
    pub total: u32,
    pub epoch: u64,
}
