//! The RAW format plugin.
//!
//! This is the "plugin for a particular format" the rest of the app never
//! needs to know about: it implements [`SceneFormat`] and hands back
//! scene-linear pixels, exactly like the built-in plugin for JPEG does.
//!
//! ## Why Core Image and not a Rust decoder
//!
//! The obvious choice would be a pure-Rust decoder (`rawler`, `rawloader`).
//! It does not work for the files this was built against: recent Nikon bodies
//! record **High Efficiency / HE\*** NEFs, a TicoRAW-derived compression that
//! is licensed, undocumented, and consequently unsupported by every
//! open-source decoder — rawler rejects them outright, and LibRaw (hence
//! darktable and RawTherapee) cannot read them either.
//!
//! macOS decodes them natively, so this plugin drives `CIRAWFilter`. That
//! follows the precedent already set for AVIF, which likewise has no viable
//! Rust decoder and is left to the platform.
//!
//! Core Image is used for exactly two things: demosaicing, and white balance
//! in sensor space (which must happen before demosaicing to be correct, and
//! is the one adjustment a generic pipeline genuinely cannot do properly).
//! Everything Apple would otherwise add — its tone curve, contrast, sharpening
//! and gamut mapping — is switched off, because exposure and tone belong to
//! `imgvwr-develop` and must behave identically for every format.

use imgvwr_core::SceneFormat;

/// The extensions this plugin claims — the same list scanning uses, so a file
/// the gallery shows as raw is exactly a file this plugin offers to open.
pub use imgvwr_core::scan::{is_raw_extension, RAW_EXTENSIONS};

#[cfg(target_os = "macos")]
mod core_image;

#[cfg(target_os = "macos")]
pub use core_image::CoreImageRawFormat;

/// Frame size of a raw file without decoding it, or `None` when this platform
/// (or this file) cannot report one. Lets metadata cover raw files, which no
/// Rust decoder can measure.
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

/// The plugin for this platform.
///
/// On macOS this is the Core Image implementation. Elsewhere it is a plugin
/// that claims nothing, so RAW files simply have no develop support rather
/// than the app failing to build — the same shape the AVIF gap already takes.
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
