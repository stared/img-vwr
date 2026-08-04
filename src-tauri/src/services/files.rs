//! Removing files — the app's only destructive path over the user's photos.
//!
//! Two decisions shape it.
//!
//! **The Trash, never `unlink`.** Everything else the app writes is app-local
//! and reversible: edits and labels live in its own database and the original
//! file is never touched. Deleting breaks that, so the one operation that
//! does reach a photograph hands it to the recycle bin the platform already
//! has, where the user can get it back with the file manager they already
//! know. A viewer is not the right place to be the last word on a raw file.
//!
//! **Each file answers for itself.** A batch of twenty where the third one is
//! read-only must not leave the first two gone, the rest untouched and the
//! caller holding an error it cannot map back to anything. So every path gets
//! its own verdict and the caller is told exactly which ones went — that list
//! is what the gallery removes, and a file that survived stays on screen
//! because it is still on disk.

use std::path::Path;

use serde::Serialize;

/// What became of a batch: what actually went, and what did not, with why.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashOutcome {
    /// Paths that reached the Trash — exactly what the collection may drop.
    pub removed: Vec<String>,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    pub path: String,
    pub error: String,
}

/// Move each path to the platform Trash, reporting per file.
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

/// One file to the Trash.
///
/// Only a regular file, and checked without following symlinks. The frontend
/// only ever passes paths it is displaying, so this guard should never fire —
/// which is the point: it is the last thing standing between a bug up there
/// and a directory tree going to the Trash on the user's behalf.
fn trash_one(context: &trash::TrashContext, path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{e}"))?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    context.delete(path).map_err(|e| format!("{e}"))
}

/// How the platform is asked to do it.
///
/// On macOS the crate's default is to script the Finder, which makes the OS
/// ask the user to let this app control Finder — a permission prompt with a
/// far bigger blast radius than the thing being asked for, and a delete that
/// simply fails if they decline. `NSFileManager` needs no permission at all.
///
/// The cost is that macOS then may not offer "Put Back" on the trashed file
/// (a long-standing bug in that API, not in the crate). The file is in the
/// Trash either way and can be dragged out of it, which is the guarantee that
/// matters: this app never destroys a photograph, it only puts it somewhere
/// the user can change their mind.
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

#[cfg(test)]
mod tests {
    use super::*;

    /* Nothing here trashes anything: a test that did would be putting files
     * into whoever ran it's Trash. What is worth testing is the refusals —
     * the cases where a wrong path must produce an error rather than a
     * deletion — and those never reach `trash::delete`. */

    #[test]
    fn the_platform_is_asked_in_the_way_that_needs_no_permission() {
        // On macOS the crate's default scripts the Finder, which triggers an
        // Automation permission prompt the first time anyone deletes
        // anything. Nothing in this app should ever ask for that.
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
        // The batch reports per file, so a caller can drop what went and keep
        // showing what stayed.
        let dir = tempfile::tempdir().expect("tempdir");
        let outcome = to_trash(vec![
            dir.path().display().to_string(),
            dir.path().join("nor-this-one.jpg").display().to_string(),
        ]);
        assert_eq!(outcome.failed.len(), 2);
        assert!(outcome.removed.is_empty());
    }
}
