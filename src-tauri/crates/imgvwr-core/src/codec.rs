use std::io::Cursor;
use std::sync::Arc;

pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug)]
pub enum CodecError {
    Unsupported,
    Decode(String),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::Unsupported => write!(f, "no codec supports this file"),
            CodecError::Decode(msg) => write!(f, "decode failed: {msg}"),
        }
    }
}

impl std::error::Error for CodecError {}

pub trait ImageCodec: Send + Sync {
    fn id(&self) -> &'static str;
    /// `ext` is lowercased; `magic` is the file's first bytes.
    fn probe(&self, ext: &str, magic: &[u8]) -> bool;
    fn decode(&self, bytes: &[u8]) -> Result<DecodedImage, CodecError>;
}

pub struct CodecRegistry {
    codecs: Vec<Arc<dyn ImageCodec>>,
}

impl CodecRegistry {
    pub fn new(codecs: Vec<Arc<dyn ImageCodec>>) -> Self {
        Self { codecs }
    }

    pub fn builtin() -> Self {
        Self::new(vec![Arc::new(ImageCrateCodec)])
    }

    pub fn find(&self, ext: &str, magic: &[u8]) -> Option<&dyn ImageCodec> {
        self.codecs
            .iter()
            .find(|c| c.probe(ext, magic))
            .map(|c| c.as_ref())
    }

    pub fn decode(&self, ext: &str, bytes: &[u8]) -> Result<DecodedImage, CodecError> {
        let magic = &bytes[..bytes.len().min(16)];
        self.find(ext, magic)
            .ok_or(CodecError::Unsupported)?
            .decode(bytes)
    }
}

/// GIF decodes as its first frame only.
pub struct ImageCrateCodec;

const SUPPORTED_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

impl ImageCodec for ImageCrateCodec {
    fn id(&self) -> &'static str {
        "image-crate"
    }

    fn probe(&self, ext: &str, magic: &[u8]) -> bool {
        if SUPPORTED_EXTS.contains(&ext) {
            return true;
        }
        // `guess_format` recognises formats this build has no decoder for; a NEF is a
        // TIFF container, so bare magic would claim it here and shadow the raw plugin.
        matches!(
            image::guess_format(magic),
            Ok(image::ImageFormat::Png
                | image::ImageFormat::Jpeg
                | image::ImageFormat::WebP
                | image::ImageFormat::Gif)
        )
    }

    fn decode(&self, bytes: &[u8]) -> Result<DecodedImage, CodecError> {
        let img = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| CodecError::Decode(e.to_string()))?
            .decode()
            .map_err(|e| CodecError::Decode(e.to_string()))?
            .into_rgba8();
        Ok(DecodedImage {
            width: img.width(),
            height: img.height(),
            rgba: img.into_raw(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    #[test]
    fn probe_accepts_by_extension() {
        assert!(ImageCrateCodec.probe("png", &[]));
        assert!(ImageCrateCodec.probe("jpeg", &[]));
        assert!(!ImageCrateCodec.probe("avif", &[]));
    }

    #[test]
    fn probe_accepts_by_magic_bytes() {
        assert!(ImageCrateCodec.probe("dat", PNG_MAGIC));
    }

    #[test]
    fn probe_declines_formats_this_build_cannot_decode() {
        // TIFF magic is also how camera raw files start; claiming it would shadow the raw plugin.
        const TIFF_MAGIC: &[u8] = &[0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0];
        assert!(!ImageCrateCodec.probe("nef", TIFF_MAGIC));
        assert!(!ImageCrateCodec.probe("tif", TIFF_MAGIC));
        assert!(CodecRegistry::builtin().find("nef", TIFF_MAGIC).is_none());
    }

    #[test]
    fn registry_routes_to_first_match_or_none() {
        let registry = CodecRegistry::builtin();
        assert!(registry.find("png", PNG_MAGIC).is_some());
        assert!(registry.find("avif", &[0u8; 16]).is_none());
    }

    #[test]
    fn decode_roundtrips_a_real_png() {
        let mut png = Vec::new();
        image::DynamicImage::new_rgba8(3, 2)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let decoded = CodecRegistry::builtin().decode("png", &png).unwrap();
        assert_eq!((decoded.width, decoded.height), (3, 2));
        assert_eq!(decoded.rgba.len(), 3 * 2 * 4);
    }
}
