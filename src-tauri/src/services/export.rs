use std::path::{Path, PathBuf};

use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportFormat {
    Jpeg { quality: u8 },
    Png,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Jpeg { .. } => "jpg",
            Self::Png => "png",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportSize {
    /// Never more than the source holds: an export is not an upscaler.
    Full,
    Longest { pixels: u32 },
}

impl ExportSize {
    pub fn edge(&self, native: u32) -> u32 {
        match self {
            Self::Full => native.max(1),
            Self::Longest { pixels } => (*pixels).min(native).max(1),
        }
    }

    fn is_full(&self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExifSource {
    None,
    File { path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportJob {
    /// Settings are not in the job: they are already saved in `develop.db`.
    Render { path: String, exif: ExifSource },
    Copy { path: String },
}

impl ExportJob {
    pub fn source(&self) -> &str {
        match self {
            Self::Render { path, .. } => path,
            Self::Copy { path } => path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub folder: String,
    pub format: ExportFormat,
    pub size: ExportSize,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub source: String,
    /// Not always the name asked for: an export never overwrites an existing file.
    pub path: String,
    /// True only for the byte-for-byte case — a resized copy re-encodes and reports false.
    pub copied: bool,
}

/// Never overwrites: a second export lands beside the first, not over it.
pub fn destination_for(folder: &Path, source: &str, extension: &str) -> PathBuf {
    let stem = Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let first = folder.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for n in 1..10_000 {
        let candidate = folder.join(format!("{stem}-{n}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// Full-size JPEG-to-JPEG is a byte-for-byte copy: no re-encode, metadata intact.
pub fn copy_jpeg(source: &Path, plan: &ExportPlan, destination: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(source).map_err(|e| e.to_string())?;

    if plan.size.is_full() && matches!(plan.format, ExportFormat::Jpeg { .. }) {
        std::fs::write(destination, &bytes).map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let native = img.width().max(img.height());
    let edge = plan.size.edge(native);
    let scaled = if edge < native {
        let scale = edge as f32 / native.max(1) as f32;
        img.resize(
            ((img.width() as f32 * scale).round() as u32).max(1),
            ((img.height() as f32 * scale).round() as u32).max(1),
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };

    match plan.format {
        ExportFormat::Png => scaled.into_rgba8().save(destination).map_err(|e| e.to_string())?,
        ExportFormat::Jpeg { quality } => {
            let encoded = encode_jpeg(&scaled.into_rgb8(), quality)?;
            let out = match app1_of(&bytes) {
                Some(app1) => with_app1(&encoded, &app1),
                None => encoded,
            };
            std::fs::write(destination, out).map_err(|e| e.to_string())?;
        }
    }
    Ok(false)
}

pub fn write_rendered(
    image: RgbaImage,
    plan: &ExportPlan,
    exif: &ExifSource,
    destination: &Path,
) -> Result<(), String> {
    match plan.format {
        ExportFormat::Png => image.save(destination).map_err(|e| e.to_string()),
        ExportFormat::Jpeg { quality } => {
            let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
            let encoded = encode_jpeg(&rgb, quality)?;
            let out = match exif_bytes(exif).as_deref().and_then(app1_of) {
                Some(app1) => with_app1(&encoded, &app1_upright(&app1)),
                None => encoded,
            };
            std::fs::write(destination, out).map_err(|e| e.to_string())
        }
    }
}

fn exif_bytes(exif: &ExifSource) -> Option<Vec<u8>> {
    match exif {
        ExifSource::None => None,
        ExifSource::File { path } => std::fs::read(path).ok(),
    }
}

fn encode_jpeg(image: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
        .encode_image(image)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// The APP1/Exif segment, marker and length included — raw bytes, moved unchanged so no maker note is lost.
pub fn app1_of(jpeg: &[u8]) -> Option<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut at = 2usize;
    while at + 4 <= jpeg.len() {
        if jpeg[at] != 0xFF {
            return None;
        }
        let marker = jpeg[at + 1];
        // SOS/EOI: no more headers to walk.
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let length = u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]) as usize;
        let end = at + 2 + length;
        if length < 2 || end > jpeg.len() {
            return None;
        }
        if marker == 0xE1 && jpeg[at + 4..end.min(at + 10)].starts_with(b"Exif\0") {
            return Some(jpeg[at..end].to_vec());
        }
        at = end;
    }
    None
}

/// Rendered pixels are already upright; an unchanged Orientation tag would rotate them a second time.
pub fn app1_upright(app1: &[u8]) -> Vec<u8> {
    let mut out = app1.to_vec();
    // FF E1, length, "Exif\0\0" — then the TIFF header all offsets count from.
    const TIFF: usize = 10;
    if out.len() < TIFF + 8 || !out[4..TIFF].starts_with(b"Exif\0") {
        return out;
    }
    let le = match &out[TIFF..TIFF + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return out,
    };
    let word = |b: &[u8]| u16::from_be_bytes([b[0], b[1]]);
    let read16 = |b: &[u8]| if le { word(b).swap_bytes() } else { word(b) };
    let ifd0 = {
        let b = &out[TIFF + 4..TIFF + 8];
        let raw = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        TIFF + (if le { raw.swap_bytes() } else { raw }) as usize
    };
    if ifd0 + 2 > out.len() {
        return out;
    }
    let entries = read16(&out[ifd0..ifd0 + 2]) as usize;
    for i in 0..entries {
        let at = ifd0 + 2 + i * 12;
        if at + 12 > out.len() {
            return out;
        }
        // Orientation (0x0112) is a SHORT with count 1: the value lives in the entry's own value field.
        if read16(&out[at..at + 2]) == 0x0112 {
            let upright = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            out[at + 8] = upright[0];
            out[at + 9] = upright[1];
            return out;
        }
    }
    out
}

pub fn with_app1(jpeg: &[u8], app1: &[u8]) -> Vec<u8> {
    if jpeg.len() < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return jpeg.to_vec();
    }
    let mut out = Vec::with_capacity(jpeg.len() + app1.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn plan(folder: &Path, format: ExportFormat, size: ExportSize) -> ExportPlan {
        ExportPlan {
            folder: folder.to_str().unwrap().to_string(),
            format,
            size,
        }
    }

    /// Enough real IFD0 structure that a patch has to walk the directory, not pattern-match.
    fn app1_with_orientation(orientation: u16, le: bool) -> Vec<u8> {
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(if le { b"II" } else { b"MM" });
        tiff.extend_from_slice(&w16(42));
        tiff.extend_from_slice(&w32(8)); // IFD0 follows immediately
        tiff.extend_from_slice(&w16(2)); // two entries
        for (tag, value) in [(0x010e_u16, 99_u16), (0x0112, orientation)] {
            tiff.extend_from_slice(&w16(tag));
            tiff.extend_from_slice(&w16(3)); // SHORT
            tiff.extend_from_slice(&w32(1));
            tiff.extend_from_slice(&w16(value));
            tiff.extend_from_slice(&w16(0)); // value field padding
        }
        tiff.extend_from_slice(&w32(0)); // no next IFD

        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((tiff.len() + 6 + 2) as u16).to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        app1
    }

    fn jpeg_with_exif(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(width, height, |x, _| {
            image::Rgb([(x % 256) as u8, 128, 64])
        });
        let encoded = encode_jpeg(&img, 90).unwrap();
        with_app1(&encoded, &app1_with_orientation(6, false))
    }

    #[test]
    fn an_exif_segment_survives_a_round_trip() {
        let jpeg = jpeg_with_exif(32, 16);
        let app1 = app1_of(&jpeg).expect("the segment we just wrote");
        assert_eq!(&app1[..2], &[0xFF, 0xE1]);
        assert_eq!(app1, app1_with_orientation(6, false));

        let plain = encode_jpeg(&RgbImage::new(4, 4), 90).unwrap();
        assert!(app1_of(&plain).is_none());
        assert_eq!(app1_of(&with_app1(&plain, &app1)), Some(app1));
    }

    #[test]
    fn rendered_pixels_are_upright_so_the_orientation_tag_must_not_turn_them_again() {
        for le in [false, true] {
            for orientation in [2u16, 3, 5, 6, 8] {
                let before = app1_with_orientation(orientation, le);
                let after = app1_upright(&before);
                assert_eq!(after, app1_with_orientation(1, le), "orientation {orientation}, le {le}");
                assert_eq!(after.len(), before.len());
            }
        }
    }

    #[test]
    fn a_segment_that_is_not_understood_is_left_exactly_as_it_was() {
        // No Exif marker, unknown byte order, truncated mid-directory.
        let odd = vec![0xFF, 0xE1, 0x00, 0x04, 0x58, 0x58];
        assert_eq!(app1_upright(&odd), odd);
        let mut wrong_order = app1_with_orientation(6, false);
        wrong_order[10..12].copy_from_slice(b"XX");
        assert_eq!(app1_upright(&wrong_order), wrong_order);
        let truncated = app1_with_orientation(6, false)[..20].to_vec();
        assert_eq!(app1_upright(&truncated), truncated);
    }

    #[test]
    fn a_file_that_is_not_a_jpeg_yields_no_metadata_rather_than_nonsense() {
        assert!(app1_of(b"").is_none());
        assert!(app1_of(b"\x89PNG\r\n\x1a\n").is_none());
        // Truncated mid-segment: the length runs past the end of the file.
        assert!(app1_of(&[0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0x00]).is_none());
    }

    #[test]
    fn a_full_size_copy_is_the_original_file_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("DSC_0001.JPG");
        let bytes = jpeg_with_exif(64, 48);
        std::fs::write(&source, &bytes).unwrap();

        let dest = dir.path().join("out.jpg");
        let copied = copy_jpeg(
            &source,
            &plan(dir.path(), ExportFormat::Jpeg { quality: 90 }, ExportSize::Full),
            &dest,
        )
        .unwrap();

        assert!(copied, "a full-size JPEG export must not be re-encoded");
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    }

    #[test]
    fn a_resized_copy_is_re_encoded_and_keeps_its_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("DSC_0002.JPG");
        std::fs::write(&source, jpeg_with_exif(64, 48)).unwrap();

        let dest = dir.path().join("small.jpg");
        let copied = copy_jpeg(
            &source,
            &plan(
                dir.path(),
                ExportFormat::Jpeg { quality: 85 },
                ExportSize::Longest { pixels: 32 },
            ),
            &dest,
        )
        .unwrap();

        assert!(!copied);
        let written = std::fs::read(&dest).unwrap();
        let img = image::load_from_memory(&written).unwrap();
        assert_eq!((img.width(), img.height()), (32, 24));
        assert!(app1_of(&written).is_some(), "the camera's EXIF must ride along");
    }

    #[test]
    fn an_export_never_asks_for_more_pixels_than_there_are() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("DSC_0003.JPG");
        std::fs::write(&source, jpeg_with_exif(40, 30)).unwrap();

        let dest = dir.path().join("big.png");
        copy_jpeg(
            &source,
            &plan(dir.path(), ExportFormat::Png, ExportSize::Longest { pixels: 4000 }),
            &dest,
        )
        .unwrap();
        let img = image::open(&dest).unwrap();
        assert_eq!((img.width(), img.height()), (40, 30));
    }

    #[test]
    fn rendered_pixels_can_be_given_a_frames_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("DSC_0004.JPG");
        std::fs::write(&jpg, jpeg_with_exif(16, 16)).unwrap();

        let dest = dir.path().join("rendered.jpg");
        write_rendered(
            RgbaImage::new(20, 10),
            &plan(dir.path(), ExportFormat::Jpeg { quality: 92 }, ExportSize::Full),
            &ExifSource::File {
                path: jpg.to_str().unwrap().to_string(),
            },
            &dest,
        )
        .unwrap();

        let written = std::fs::read(&dest).unwrap();
        let app1 = app1_of(&written).expect("the sibling JPG's EXIF must ride along");
        // Orientation reset: the source said 6, but rendered pixels are already upright.
        assert_eq!(app1, app1_with_orientation(1, false));
        let img = image::load_from_memory(&written).unwrap();
        assert_eq!((img.width(), img.height()), (20, 10));
    }

    #[test]
    fn exporting_twice_writes_beside_the_first_rather_than_over_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = destination_for(dir.path(), "/cards/DSC_0009.NEF", "jpg");
        assert!(first.ends_with("DSC_0009.jpg"));
        std::fs::write(&first, b"x").unwrap();

        let second = destination_for(dir.path(), "/cards/DSC_0009.NEF", "jpg");
        assert!(second.ends_with("DSC_0009-1.jpg"), "{second:?}");
    }
}
