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

/// Non-hidden subdirectories of `dir`, natural-sorted (lazy sidebar tree, one level).
pub fn list_subdirs(dir: &Path) -> std::io::Result<Vec<DirEntry>> {
    let mut dirs: Vec<DirEntry> = std::fs::read_dir(dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_str()?.to_owned();
            if name.starts_with('.') || !entry.metadata().ok()?.is_dir() {
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
}
