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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailFailed {
    pub path: String,
    pub error: String,
    pub epoch: u64,
}
