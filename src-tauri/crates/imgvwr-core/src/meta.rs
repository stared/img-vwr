use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExifSubset {
    pub orientation: u32,
    pub date_time: Option<String>,
    pub camera: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    /// None when no Rust decoder knows the format (e.g. AVIF) — the webview
    /// can still measure the image it renders natively.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: String,
    pub file_size: u64,
    pub modified_ms: u64,
    pub exif: Option<ExifSubset>,
}

/// Header-only metadata read: image dimensions without a full decode, plus a
/// small EXIF subset. Never fails on undecodable pixels — fields degrade to None.
pub fn read_meta(path: &Path) -> std::io::Result<ImageMeta> {
    let fs_meta = std::fs::metadata(path)?;
    let modified_ms = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let dims = image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok());

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    Ok(ImageMeta {
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
        format,
        file_size: fs_meta.len(),
        modified_ms,
        exif: read_exif(path),
    })
}

fn read_exif(path: &Path) -> Option<ExifSubset> {
    let file = File::open(path).ok()?;
    let data = exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;

    let field_string = |tag: exif::Tag| {
        data.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string().trim_matches('"').to_owned())
    };

    Some(ExifSubset {
        orientation: data
            .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .unwrap_or(1),
        date_time: field_string(exif::Tag::DateTimeOriginal).or_else(|| field_string(exif::Tag::DateTime)),
        camera: field_string(exif::Tag::Model),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dimensions_without_full_decode() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("img.png");
        image::DynamicImage::new_rgb8(320, 200).save(&path).unwrap();

        let meta = read_meta(&path).unwrap();
        assert_eq!((meta.width, meta.height), (Some(320), Some(200)));
        assert_eq!(meta.format, "png");
        assert!(meta.file_size > 0);
    }

    #[test]
    fn degrades_gracefully_on_undecodable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("img.avif");
        std::fs::write(&path, b"pretend avif").unwrap();

        let meta = read_meta(&path).unwrap();
        assert_eq!(meta.width, None);
        assert_eq!(meta.format, "avif");
        assert!(meta.exif.is_none());
    }
}
