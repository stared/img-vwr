use std::path::Path;

use serde::{Deserialize, Serialize};

/// Extensions the viewer knows how to display. AVIF has no Rust decoder in v1
/// but WKWebView renders it natively, so it is listed here.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    /// Lowercased extension, e.g. "png".
    pub format_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub path: String,
    pub name: String,
}

/// True for files the gallery should show: known image extension, not hidden.
pub fn is_image_candidate(name: &str) -> bool {
    if name.starts_with('.') {
        return false;
    }
    match name.rsplit_once('.') {
        Some((_, ext)) => IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Compare filenames so that "img2" < "img10" (digit runs compare numerically).
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (na, ni) = take_number(a, i);
            let (nb, nj) = take_number(b, j);
            match na.cmp(&nb) {
                std::cmp::Ordering::Equal => {
                    i = ni;
                    j = nj;
                }
                other => return other,
            }
        } else {
            match a[i].to_ascii_lowercase().cmp(&b[j].to_ascii_lowercase()) {
                std::cmp::Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                other => return other,
            }
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

fn take_number(s: &[u8], start: usize) -> (u128, usize) {
    let mut end = start;
    while end < s.len() && s[end].is_ascii_digit() {
        end += 1;
    }
    // Saturate rather than panic on absurdly long digit runs.
    let value = s[start..end]
        .iter()
        .fold(0u128, |acc, d| acc.saturating_mul(10).saturating_add(u128::from(d - b'0')));
    (value, end)
}

/// One non-recursive pass over `dir`: image files only, natural-sorted by name.
pub fn scan_dir(dir: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut entries: Vec<FileEntry> = std::fs::read_dir(dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_str()?.to_owned();
            if !is_image_candidate(&name) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let format_hint = name
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
                .unwrap_or_default();
            Some(FileEntry {
                path: entry.path().to_str()?.to_owned(),
                name,
                size: meta.len(),
                modified_ms,
                format_hint,
            })
        })
        .collect();
    entries.sort_by(|x, y| natural_cmp(&x.name, &y.name));
    Ok(entries)
}

/// Guard against runaway trees; no sane photo library nests deeper.
const MAX_SCAN_DEPTH: usize = 32;

/// Every image under `dir`, any depth. Hidden directories and symlinks are
/// skipped (symlinked dirs could cycle); delivery order is the natural sort
/// of the path relative to `dir`, so one folder's files stay together.
pub fn scan_dir_recursive(dir: &Path) -> std::io::Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    // (path, depth) — the root must exist; deeper unreadable dirs are skipped.
    let mut queue = vec![(dir.to_path_buf(), 0usize)];
    let root = std::fs::read_dir(dir)?; // surface a bad root as an error
    drop(root);
    while let Some((current, depth)) = queue.pop() {
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.filter_map(|e| e.ok()) {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // file_type() does not follow symlinks, so linked dirs (cycles)
            // and linked files are both skipped here.
            if file_type.is_dir() {
                if !name.starts_with('.') && depth < MAX_SCAN_DEPTH {
                    queue.push((entry.path(), depth + 1));
                }
                continue;
            }
            if !file_type.is_file() || !is_image_candidate(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let format_hint = name
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
                .unwrap_or_default();
            let Some(path) = entry.path().to_str().map(str::to_owned) else {
                continue;
            };
            entries.push(FileEntry {
                path,
                name,
                size: meta.len(),
                modified_ms,
                format_hint,
            });
        }
    }
    let prefix = dir.to_str().map(str::to_owned).unwrap_or_default();
    entries.sort_by(|x, y| {
        natural_cmp(
            x.path.strip_prefix(&prefix).unwrap_or(&x.path),
            y.path.strip_prefix(&prefix).unwrap_or(&y.path),
        )
    });
    Ok(entries)
}

/// Count image files directly inside `dir`. Cheap: filename filter plus the
/// dirent file type — no per-file stat. Unreadable dirs count as 0.
pub fn count_images(dir: &Path) -> u32 {
    match std::fs::read_dir(dir) {
        Ok(read) => read
            .filter_map(|entry| entry.ok())
            .filter(|e| e.file_name().to_str().is_some_and(is_image_candidate))
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .count() as u32,
        Err(_) => 0,
    }
}

/// Non-hidden subdirectories of `dir`, natural-sorted (lazy sidebar tree, one
/// level). Deliberately does NOT count contents — on cloud-backed folders
/// (Dropbox, iCloud) reading each subdir can take seconds, so counts are
/// computed in the background and streamed as events.
pub fn list_subdirs(dir: &Path) -> std::io::Result<Vec<DirEntry>> {
    let mut dirs: Vec<DirEntry> = std::fs::read_dir(dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_str()?.to_owned();
            if name.starts_with('.') || !entry.file_type().ok()?.is_dir() {
                return None;
            }
            Some(DirEntry {
                path: entry.path().to_str()?.to_owned(),
                name,
            })
        })
        .collect();
    dirs.sort_by(|x, y| natural_cmp(&x.name, &y.name));
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn filters_by_extension_case_insensitively() {
        assert!(is_image_candidate("photo.png"));
        assert!(is_image_candidate("photo.JPG"));
        assert!(is_image_candidate("photo.Avif"));
        assert!(!is_image_candidate("notes.txt"));
        assert!(!is_image_candidate("archive.zip"));
        assert!(!is_image_candidate("noextension"));
    }

    #[test]
    fn filters_hidden_files() {
        assert!(!is_image_candidate(".hidden.png"));
        assert!(!is_image_candidate(".DS_Store"));
    }

    #[test]
    fn natural_sort_orders_digit_runs_numerically() {
        assert_eq!(natural_cmp("img2.png", "img10.png"), Ordering::Less);
        assert_eq!(natural_cmp("img10.png", "img2.png"), Ordering::Greater);
        assert_eq!(natural_cmp("a.png", "b.png"), Ordering::Less);
        assert_eq!(natural_cmp("IMG5.png", "img5.png"), Ordering::Equal);
        assert_eq!(natural_cmp("x.png", "x1.png"), Ordering::Less);
    }

    #[test]
    fn scan_dir_filters_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["b10.png", "b2.jpg", "a.webp", "skip.txt", ".hidden.png"] {
            std::fs::write(tmp.path().join(name), b"x").unwrap();
        }
        std::fs::create_dir(tmp.path().join("subdir.png")).unwrap(); // dir, must be skipped

        let names: Vec<String> = scan_dir(tmp.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["a.webp", "b2.jpg", "b10.png"]);
    }

    #[test]
    fn scan_dir_recursive_walks_subfolders_and_groups_by_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("b/inner")).unwrap();
        std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
        std::fs::write(tmp.path().join("top.png"), b"x").unwrap();
        std::fs::write(tmp.path().join("b/two.jpg"), b"x").unwrap();
        std::fs::write(tmp.path().join("b/inner/deep.webp"), b"x").unwrap();
        std::fs::write(tmp.path().join(".hidden/skip.png"), b"x").unwrap();
        std::fs::write(tmp.path().join("b/skip.txt"), b"x").unwrap();

        let names: Vec<String> = scan_dir_recursive(tmp.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["deep.webp", "two.jpg", "top.png"]);
    }

    #[test]
    fn list_subdirs_skips_hidden_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("zeta")).unwrap();
        std::fs::create_dir(tmp.path().join("alpha")).unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        std::fs::write(tmp.path().join("file.png"), b"x").unwrap();

        let names: Vec<String> = list_subdirs(tmp.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["alpha", "zeta"]);
    }

    #[test]
    fn count_images_is_direct_and_filtered() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("deeper")).unwrap();
        for name in ["a.png", "b.jpg", ".hidden.png", "skip.txt"] {
            std::fs::write(tmp.path().join(name), b"x").unwrap();
        }
        // Images below the direct level must not count (non-recursive).
        std::fs::write(tmp.path().join("deeper").join("deep.png"), b"x").unwrap();

        assert_eq!(count_images(tmp.path()), 2);
        assert_eq!(count_images(&tmp.path().join("missing")), 0);
    }
}
