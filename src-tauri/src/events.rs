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
