use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{FaceService, PersonCluster};
use crate::services::embeddings::EmbeddingService;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FacesProgress {
    pub done: u32,
    pub total: u32,
    pub epoch: u64,
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
            let _ = FacesProgress { done, total, epoch }.emit(&app);
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
        // Inside the rayon pool, so clustering's per-face parallel searches skip the cold hand-off.
        rayon::scope(|_| faces.people(&embeddings, &paths, threshold, merge, propagate))
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
