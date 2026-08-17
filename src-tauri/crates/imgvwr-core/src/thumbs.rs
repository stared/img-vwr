use image::RgbaImage;

use crate::codec::{CodecError, CodecRegistry};

/// 512, not 256: the mosaic and a wide grid draw cells past 400 px, and a
/// thumbnail smaller than its cell is a photograph shown out of focus.
/// Bumping this re-keys the display-thumbnail cache (old files are simply
/// orphaned); the face-sidecar and vector caches deliberately pin their own
/// identity salt so they survive it.
pub const THUMB_MAX_EDGE: u32 = 512;
pub const THUMB_WEBP_QUALITY: f32 = 80.0;

#[derive(Debug)]
pub enum ThumbError {
    Codec(CodecError),
    Encode(String),
}

impl std::fmt::Display for ThumbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThumbError::Codec(e) => write!(f, "{e}"),
            ThumbError::Encode(msg) => write!(f, "webp encode failed: {msg}"),
        }
    }
}

impl std::error::Error for ThumbError {}

/// Target size with aspect ratio preserved; never upscales.
pub fn thumb_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge || longest == 0 {
        return (width, height);
    }
    let scale = f64::from(max_edge) / f64::from(longest);
    let w = ((f64::from(width) * scale).round() as u32).max(1);
    let h = ((f64::from(height) * scale).round() as u32).max(1);
    (w, h)
}

/// EXIF orientation tag value (1–8), defaulting to 1 (upright).
pub fn exif_orientation(bytes: &[u8]) -> u32 {
    exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(bytes))
        .ok()
        .and_then(|data| {
            data.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1)
}

/// Apply an EXIF orientation (1–8) to upright pixels.
pub fn apply_orientation(img: RgbaImage, orientation: u32) -> RgbaImage {
    use image::imageops;
    match orientation {
        2 => imageops::flip_horizontal(&img),
        3 => imageops::rotate180(&img),
        4 => imageops::flip_vertical(&img),
        5 => imageops::flip_horizontal(&imageops::rotate90(&img)),
        6 => imageops::rotate90(&img),
        7 => imageops::flip_horizontal(&imageops::rotate270(&img)),
        8 => imageops::rotate270(&img),
        _ => img,
    }
}

/// Pure pipeline: bytes in, encoded WebP thumbnail bytes out.
pub fn make_thumbnail(
    ext: &str,
    bytes: &[u8],
    registry: &CodecRegistry,
    max_edge: u32,
) -> Result<Vec<u8>, ThumbError> {
    let decoded = registry.decode(ext, bytes).map_err(ThumbError::Codec)?;
    let img = RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
        .ok_or_else(|| ThumbError::Codec(CodecError::Decode("pixel buffer size mismatch".into())))?;

    let img = apply_orientation(img, exif_orientation(bytes));
    let (w, h) = thumb_dimensions(img.width(), img.height(), max_edge);
    let small = image::imageops::thumbnail(&img, w, h);

    let encoded =
        webp::Encoder::from_rgba(small.as_raw(), w, h).encode_simple(false, THUMB_WEBP_QUALITY);
    match encoded {
        Ok(mem) => Ok(mem.to_vec()),
        Err(e) => Err(ThumbError::Encode(format!("{e:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_preserve_aspect_and_never_upscale() {
        assert_eq!(thumb_dimensions(1000, 500, 256), (256, 128));
        assert_eq!(thumb_dimensions(500, 1000, 256), (128, 256));
        assert_eq!(thumb_dimensions(100, 50, 256), (100, 50)); // already small
        assert_eq!(thumb_dimensions(256, 256, 256), (256, 256));
        assert_eq!(thumb_dimensions(0, 0, 256), (0, 0));
    }

    #[test]
    fn dimensions_never_round_to_zero() {
        assert_eq!(thumb_dimensions(10_000, 1, 256), (256, 1));
    }

    #[test]
    fn orientation_defaults_to_upright_on_garbage() {
        assert_eq!(exif_orientation(b"not an image"), 1);
    }

    #[test]
    fn orientation_six_rotates_dimensions() {
        let img = RgbaImage::new(4, 2);
        let rotated = apply_orientation(img, 6);
        assert_eq!((rotated.width(), rotated.height()), (2, 4));
    }

    #[test]
    fn make_thumbnail_shrinks_a_png_to_webp() {
        let mut png = Vec::new();
        image::DynamicImage::new_rgb8(800, 400)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let registry = CodecRegistry::builtin();
        let thumb = make_thumbnail("png", &png, &registry, 256).unwrap();

        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 128));
    }

    #[test]
    fn make_thumbnail_fails_cleanly_on_unsupported() {
        let registry = CodecRegistry::builtin();
        assert!(make_thumbnail("avif", &[0u8; 32], &registry, 256).is_err());
    }
}
