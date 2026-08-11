//! Getting photographs out of the app.
//!
//! Everything else here is non-destructive and app-local: edits live in
//! `develop.db`, labels in their own table, nothing is ever written beside the
//! user's originals. Export is the one place pixels leave, so it is the one
//! place that has to answer the awkward questions — what size, what quality,
//! what happens to the metadata, and what to do about the photograph that was
//! never edited at all.
//!
//! ## The unedited raw
//!
//! A shoot in raw + JPEG is mostly frames nobody touched. Rendering those from
//! the sensor produces a *different* picture from the one the camera made —
//! this app's default look, not Nikon's — and takes a couple of seconds each
//! to decode. The camera's JPEG is sitting right there, is what the
//! photographer already judged the frame by, and carries its metadata intact.
//!
//! So an export can be told to take it: an untouched photograph is *copied*,
//! byte for byte where the size allows, and only the edited ones are rendered.
//! Which files that applies to is decided on the UI side, where stacks are
//! known; this module is handed a job and does exactly what it says.
//!
//! ## Metadata
//!
//! A rendered image has no EXIF — the pipeline produces pixels, not a file
//! that remembers a camera. That is a poor thing to hand somebody: the date,
//! the lens and the exposure are half of what a photograph is. Where there is
//! a JPEG of the same frame (the camera's, beside the raw), its APP1 segment
//! is carried onto the export, so an exported edit still says when and how it
//! was taken. `ExifSource` says where to take it from, and `None` is a real
//! answer rather than a missing field.

use std::path::{Path, PathBuf};

use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};

/// What an exported file is encoded as.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportFormat {
    /// Quality on the usual 1–100 scale; 90 is the "good enough that the
    /// codec is not what you are looking at" setting.
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

/// How big the exported file is.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportSize {
    /// Everything the crop holds. Never more: an export is not an upscaler.
    Full,
    Longest { pixels: u32 },
}

impl ExportSize {
    /// The longest edge to render at, given what the source actually holds.
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

/// Where an export's metadata comes from.
///
/// A discriminated choice rather than an optional path, because "there is no
/// JPEG of this frame" is a state the caller knows and should have to say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExifSource {
    None,
    /// Carry the EXIF of this file — the camera's JPEG of the same frame.
    File { path: String },
}

/// One photograph's worth of work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportJob {
    /// Develop this file under its stored edit — or, where there is none,
    /// under what it opens with.
    ///
    /// The settings are not carried in the job: they are already in
    /// `develop.db`, every change saves there as it is made, and a batch that
    /// had to fetch them first would open every raw file twice.
    Render { path: String, exif: ExifSource },
    /// Take this JPEG as it stands. What an untouched frame in a raw + JPEG
    /// shoot exports as, and the reason exporting a whole take is fast.
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

/// The settings shared by every file in one export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub folder: String,
    pub format: ExportFormat,
    pub size: ExportSize,
}

/// What actually happened to one photograph.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub source: String,
    /// Where it landed — not always the name asked for, since an export never
    /// overwrites a file that is already there.
    pub path: String,
    /// True when the camera's own JPEG was taken rather than pixels rendered.
    pub copied: bool,
}

/// A free name in `folder` for a file made from `source`.
///
/// Never overwrites. Exporting twice into the same folder is something people
/// do by accident far more often than on purpose, and the accident that
/// silently replaces the first export is the expensive one.
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

/// Copy a JPEG out, resizing only if the plan asks for less than it holds.
///
/// The full-size case is a byte-for-byte file copy: no decode, no re-encode,
/// and every scrap of metadata the camera wrote arrives intact. That is the
/// whole point of preferring the camera's JPEG for an untouched frame — asking
/// the codec to have another go at pixels nobody changed can only lose.
pub fn copy_jpeg(source: &Path, plan: &ExportPlan, destination: &Path) -> Result<bool, String> {
    let quality = match plan.format {
        ExportFormat::Jpeg { quality } => quality,
        // A PNG export of an untouched JPEG still has to be encoded as one.
        ExportFormat::Png => 0,
    };
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
        ExportFormat::Jpeg { .. } => {
            // The camera's EXIF rides along: a resized share copy that has
            // forgotten the date and the lens is a worse photograph.
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

/// Write developed pixels, carrying metadata from `exif` where there is any.
pub fn write_rendered(
    image: RgbaImage,
    plan: &ExportPlan,
    exif: &ExifSource,
    destination: &Path,
) -> Result<(), String> {
    match plan.format {
        ExportFormat::Png => image.save(destination).map_err(|e| e.to_string()),
        ExportFormat::Jpeg { quality } => {
            // JPEG has no alpha, and a developed photograph has nothing
            // meaningful in one anyway.
            let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
            let encoded = encode_jpeg(&rgb, quality)?;
            let out = match exif_bytes(exif).as_deref().and_then(app1_of) {
                Some(app1) => with_app1(&encoded, &app1),
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

/// The APP1/Exif segment of a JPEG, marker and length included.
///
/// Bytes rather than a parsed structure on purpose. There is no EXIF *writer*
/// in this dependency tree, and there does not need to be: the segment is
/// self-contained and the only correct thing to do with somebody's camera
/// metadata is to move it across unchanged. Parsing it would be an
/// opportunity to lose a maker note.
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
        // Start of scan: the entropy-coded data begins and there are no more
        // headers to walk.
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

/// The same JPEG with an APP1 segment placed where it belongs: immediately
/// after the SOI, before any segment the encoder wrote.
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

    /// A JPEG with a plausible APP1 segment in it — enough structure that the
    /// walker has to actually parse rather than pattern-match.
    fn jpeg_with_exif(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(width, height, |x, _| {
            image::Rgb([(x % 256) as u8, 128, 64])
        });
        let encoded = encode_jpeg(&img, 90).unwrap();
        let payload = b"Exif\0\0MM\0\x2a\0\0\0\x08";
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        app1.extend_from_slice(payload);
        with_app1(&encoded, &app1)
    }

    #[test]
    fn an_exif_segment_survives_a_round_trip() {
        let jpeg = jpeg_with_exif(32, 16);
        let app1 = app1_of(&jpeg).expect("the segment we just wrote");
        assert_eq!(&app1[..2], &[0xFF, 0xE1]);
        assert!(app1.ends_with(b"MM\0\x2a\0\0\0\x08"));

        // And putting it onto another JPEG makes that one carry it too.
        let plain = encode_jpeg(&RgbImage::new(4, 4), 90).unwrap();
        assert!(app1_of(&plain).is_none());
        assert_eq!(app1_of(&with_app1(&plain, &app1)), Some(app1));
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
        assert!(app1_of(&written).is_some());
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
