use imgvwr_develop::Preset;
use tauri::State;

use super::*;

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

/// The turn and keystones that make the picture's lines plumb and level, with the focal in `settings.crop`.
#[tauri::command]
#[specta::specta]
pub async fn develop_auto_upright(
    service: State<'_, Arc<DevelopService>>,
    path: String,
    settings: DevelopSettings,
) -> Result<Upright, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.auto_upright(&path, &settings))
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
