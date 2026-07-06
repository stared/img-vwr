use std::path::PathBuf;

use imgvwr_core::{DirEntry, FileEntry};

#[tauri::command]
#[specta::specta]
pub fn scan_folder(path: PathBuf) -> Result<Vec<FileEntry>, String> {
    imgvwr_core::scan_dir(&path).map_err(|e| format!("failed to scan {}: {e}", path.display()))
}

#[tauri::command]
#[specta::specta]
pub fn list_subdirs(path: PathBuf) -> Result<Vec<DirEntry>, String> {
    imgvwr_core::list_subdirs(&path)
        .map_err(|e| format!("failed to list {}: {e}", path.display()))
}
