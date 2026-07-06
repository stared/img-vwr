use std::io::Cursor;
use std::sync::Arc;

/// A decoded image as raw RGBA8 pixels — deliberately free of `image` crate
/// types so a future WASM plugin can implement the same contract.
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

/// The core extension seam: a future plugin host wraps WASM exports in this trait.
pub trait ImageCodec: Send + Sync {
    fn id(&self) -> &'static str;
    /// Cheap check: lowercased extension plus the file's first bytes.
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

    /// Registry with all built-in codecs.
    pub fn builtin() -> Self {
        Self::new(vec![Arc::new(ImageCrateCodec)])
    }

    /// First codec whose probe accepts the file, or None (caller falls back).
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

/// Built-in codec backed by the `image` crate: PNG, JPEG, WebP, GIF (first frame).
pub struct ImageCrateCodec;

const SUPPORTED_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

impl ImageCodec for ImageCrateCodec {
    fn id(&self) -> &'static str {
        "image-crate"
    }

    fn probe(&self, ext: &str, magic: &[u8]) -> bool {
        SUPPORTED_EXTS.contains(&ext) || image::guess_format(magic).is_ok()
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
        // Wrong extension but recognizable PNG magic.
        assert!(ImageCrateCodec.probe("dat", PNG_MAGIC));
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
