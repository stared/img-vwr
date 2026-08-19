//! Deleting goes to the platform Trash, never `unlink`; each file answers for itself.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashOutcome {
    /// Only paths that actually reached the Trash — exactly what the collection may drop.
    pub removed: Vec<String>,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    pub path: String,
    pub error: String,
}

pub fn to_trash(paths: Vec<String>) -> TrashOutcome {
    let context = trash_context();
    let mut outcome = TrashOutcome { removed: Vec::new(), failed: Vec::new() };
    for path in paths {
        match trash_one(&context, Path::new(&path)) {
            Ok(()) => outcome.removed.push(path),
            Err(error) => outcome.failed.push(TrashFailure { path, error }),
        }
    }
    outcome
}

/// Regular files only, checked without following symlinks — the last guard between a frontend bug and a directory tree going to the Trash.
fn trash_one(context: &trash::TrashContext, path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{e}"))?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    context.delete(path).map_err(|e| format!("{e}"))
}

/// NSFileManager, not the crate's Finder-scripting default: no Automation prompt (cost: macOS may not offer "Put Back" — an Apple API bug).
fn trash_context() -> trash::TrashContext {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos as _};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
}

/// All or nothing — a pasteboard holds one thing — so missing files are refused before anything is written.
#[cfg(target_os = "macos")]
pub fn to_clipboard(paths: &[String]) -> Result<u32, String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSString, NSURL};

    if paths.is_empty() {
        return Err("nothing to copy".to_string());
    }
    if let Some(gone) = paths.iter().find(|p| !Path::new(p).is_file()) {
        return Err(format!("not a file: {gone}"));
    }
    let urls: Vec<_> = paths
        .iter()
        .map(|p| ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(p))))
        .collect();
    let objects = NSArray::from_retained_slice(&urls);
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&objects) {
        Ok(paths.len() as u32)
    } else {
        Err("the pasteboard did not take the files".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn to_clipboard(_paths: &[String]) -> Result<u32, String> {
    Err("copying files is not implemented for this platform yet".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Nothing here trashes anything — that would fill the runner's own Trash; only the refusals are tested.

    #[test]
    fn the_platform_is_asked_in_the_way_that_needs_no_permission() {
        // The crate's Finder-scripting default triggers an Automation prompt; this app must never ask for that.
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos as _};
            assert!(matches!(trash_context().delete_method(), DeleteMethod::NsFileManager));
        }
    }

    #[test]
    fn a_directory_is_never_trashed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outcome = to_trash(vec![dir.path().display().to_string()]);
        assert!(outcome.removed.is_empty());
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].error, "not a file");
        assert!(dir.path().exists(), "the directory is still there");
    }

    #[test]
    fn a_path_that_is_not_there_fails_rather_than_counting_as_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("never-existed.jpg");
        let outcome = to_trash(vec![missing.display().to_string()]);
        assert!(outcome.removed.is_empty());
        assert_eq!(outcome.failed.len(), 1);
    }

    #[test]
    fn one_bad_path_does_not_speak_for_the_others() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outcome = to_trash(vec![
            dir.path().display().to_string(),
            dir.path().join("nor-this-one.jpg").display().to_string(),
        ]);
        assert_eq!(outcome.failed.len(), 2);
        assert!(outcome.removed.is_empty());
    }
}
