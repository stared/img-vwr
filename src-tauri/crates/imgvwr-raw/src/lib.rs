//! Core Image, not a Rust decoder: recent Nikon High Efficiency (HE*) NEFs are TicoRAW-derived
//! and defeat rawler and LibRaw alike; macOS decodes them natively.

use imgvwr_core::SceneFormat;

/// The same list scanning uses: what the gallery shows as raw is exactly what this plugin offers to open.
pub use imgvwr_core::scan::{is_raw_extension, RAW_EXTENSIONS};

#[cfg(target_os = "macos")]
mod core_image;
mod preview;

#[cfg(target_os = "macos")]
pub use core_image::CoreImageRawFormat;
pub use preview::embedded_jpeg;

/// Frame size without decoding; None when this platform (or file) cannot report one.
pub fn raw_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    #[cfg(target_os = "macos")]
    {
        core_image::dimensions(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

/// Off macOS this is a plugin that claims nothing, so raw files degrade instead of the build failing.
pub fn raw_format() -> Box<dyn SceneFormat> {
    #[cfg(target_os = "macos")]
    {
        Box::new(CoreImageRawFormat::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(UnsupportedRawFormat)
    }
}

#[cfg(not(target_os = "macos"))]
struct UnsupportedRawFormat;

#[cfg(not(target_os = "macos"))]
impl SceneFormat for UnsupportedRawFormat {
    fn id(&self) -> &'static str {
        "raw-unsupported"
    }

    fn probe(&self, _ext: &str, _magic: &[u8]) -> bool {
        false
    }

    fn open(
        &self,
        _path: &std::path::Path,
    ) -> Result<Box<dyn imgvwr_core::SceneImage>, imgvwr_core::SceneError> {
        Err(imgvwr_core::SceneError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_nikon_and_common_raw_extensions() {
        assert!(is_raw_extension("nef"));
        assert!(is_raw_extension("cr3"));
        assert!(is_raw_extension("dng"));
        assert!(!is_raw_extension("jpg"));
        assert!(!is_raw_extension("png"));
    }
}
