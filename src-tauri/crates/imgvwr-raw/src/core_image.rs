use std::ffi::c_void;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Mutex;

use imgvwr_core::{
    LinearImage, Rendering, RenderRequest, SceneError, SceneFormat, SceneImage, WhiteBalance,
};
use objc2::rc::Retained;
use objc2_core_foundation::CGRect;
use objc2_core_graphics::{kCGColorSpaceExtendedLinearSRGB, CGColorSpace};
use objc2_core_image::{kCIFormatRGBAf, CIContext, CIRAWFilter};
use objc2_foundation::{NSString, NSURL};

use crate::is_raw_extension;

pub struct CoreImageRawFormat;

impl Default for CoreImageRawFormat {
    fn default() -> Self {
        Self::new()
    }
}

impl CoreImageRawFormat {
    pub fn new() -> Self {
        Self
    }
}

impl SceneFormat for CoreImageRawFormat {
    fn id(&self) -> &'static str {
        "core-image-raw"
    }

    fn probe(&self, ext: &str, _magic: &[u8]) -> bool {
        is_raw_extension(ext)
    }

    fn open(&self, path: &Path) -> Result<Box<dyn SceneImage>, SceneError> {
        let path_str = path
            .to_str()
            .ok_or_else(|| SceneError::Open("path is not valid UTF-8".into()))?;

        // SAFETY: plain Objective-C message sends to a filter object we exclusively own.
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
            let filter = CIRAWFilter::filterWithImageURL(&url).ok_or_else(|| {
                SceneError::Open(format!(
                    "the system RAW decoder does not support {}",
                    path.display()
                ))
            })?;

            // Apple's look (tone curve, shadow boost, gamut mapping) is switched off so the sliders don't stack on an invisible opinion. Sharpening/NR stay:
            // without them a decode has under half the camera JPEG's edge energy at base ISO and many times its noise in the dark (fit_detail example).
            filter.setBoostAmount(0.0);
            filter.setBoostShadowAmount(0.0);
            filter.setGamutMappingEnabled(false);
            let (sharpness, nr_floor) = detail_settings(
                imgvwr_core::read_meta(path)
                    .ok()
                    .and_then(|m| m.exif)
                    .and_then(|e| e.iso),
            );
            if filter.isSharpnessSupported() {
                filter.setSharpnessAmount(sharpness);
            }
            if filter.isContrastSupported() {
                filter.setContrastAmount(0.0);
            }
            if filter.isDetailSupported() {
                filter.setDetailAmount(0.0);
            }
            if filter.isLocalToneMapSupported() {
                filter.setLocalToneMapAmount(0.0);
            }
            // The floor only ever raises Apple's ISO ramp, which starts too late and ends too low vs the camera JPEGs; colour NR is left as Apple set it (measured neutral).
            let lnr = filter.luminanceNoiseReductionAmount();
            if lnr < nr_floor {
                filter.setLuminanceNoiseReductionAmount(nr_floor);
            }
            // Not a look: recovery reconstructs clipped channels, which is what lets a highlights slider recover anything.
            if filter.isHighlightRecoverySupported() {
                filter.setHighlightRecoveryEnabled(true);
            }

            let as_shot = WhiteBalance {
                temperature: filter.neutralTemperature(),
                tint: filter.neutralTint(),
            };

            // Reading the extent forces the initial parse (~2 s for a 24 MP NEF) here, so later renders take the ~8 ms path.
            filter.setScaleFactor(1.0);
            let extent = filter
                .outputImage()
                .ok_or_else(|| SceneError::Open("RAW decoder produced no image".into()))?
                .extent();
            let native = (extent.size.width as u32, extent.size.height as u32);
            if native.0 == 0 || native.1 == 0 {
                return Err(SceneError::Open("RAW decoder reported an empty image".into()));
            }

            let context = CIContext::new();

            Ok(Box::new(CoreImageRawScene {
                inner: Mutex::new(Inner { filter, context }),
                native,
                as_shot,
                sharpness,
            }))
        }
    }
}

/// Fitted against the camera's JPEGs (`fit_detail` example, 2026-08-14): sharpening 1.0 up to
/// ISO 1600 fading to 0 by 6400, NR floor rising to 0.7 from ISO 800; both ramps linear in stops.
fn detail_settings(iso: Option<u32>) -> (f32, f32) {
    let iso = iso.unwrap_or(400).max(1) as f32;
    let stops = iso.log2();
    let sharpness = 1.0 - ((stops - 1600f32.log2()) / 2.0).clamp(0.0, 1.0);
    let nr_floor = 0.7 * ((stops - 800f32.log2()) / 3.0).clamp(0.0, 1.0);
    (sharpness, nr_floor)
}

/// Header-only: creating the filter defers demosaic setup, so this is cheap enough for a folder sweep.
pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
    // SAFETY: header-only property reads on a filter object we own.
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let filter = CIRAWFilter::filterWithImageURL(&url)?;
        let size = filter.nativeSize();
        let (w, h) = (size.width as u32, size.height as u32);
        if w == 0 || h == 0 {
            return None;
        }
        // `nativeSize` is unoriented; EXIF 5–8 are the quarter turns. Matched numerically to avoid an Image I/O dependency just for the enum.
        let rotated = matches!(filter.orientation() as u32, 5..=8);
        Some(if rotated { (h, w) } else { (w, h) })
    }
}

struct Inner {
    filter: Retained<CIRAWFilter>,
    context: Retained<CIContext>,
}

struct CoreImageRawScene {
    inner: Mutex<Inner>,
    native: (u32, u32),
    as_shot: WhiteBalance,
    /// Applied only near 1:1: at preview scales the radius is sub-pixel while costing ~80 ms per slider drag.
    sharpness: f32,
}

// SAFETY: `CIContext` is documented thread-safe; the filter is only reached through the mutex.
unsafe impl Send for CoreImageRawScene {}
unsafe impl Sync for CoreImageRawScene {}

impl SceneImage for CoreImageRawScene {
    fn native_size(&self) -> (u32, u32) {
        self.native
    }

    fn rendering(&self) -> Rendering {
        Rendering::SceneReferred
    }

    fn as_shot(&self) -> WhiteBalance {
        self.as_shot
    }

    fn neutral_at(
        &self,
        x: f32,
        y: f32,
        current: WhiteBalance,
    ) -> Result<WhiteBalance, SceneError> {
        // CI's `neutralLocation` looks like the right tool and measurably is not: setting it
        // never moves neutralTemperature/Tint, so the raw path measures a developed patch too.
        imgvwr_core::neutral_by_measurement(self, x, y, current)
    }

    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError> {
        let region = req.region.clamped();
        // Scale is chosen against the requested region, not the frame: a 1:1 crop costs a small render.
        let region_longest =
            (self.native.0 as f32 * region.width).max(self.native.1 as f32 * region.height);
        let scale = (req.max_edge.max(1) as f32 / region_longest.max(1.0)).min(1.0);

        let inner = self
            .inner
            .lock()
            .map_err(|_| SceneError::Render("RAW decoder lock poisoned".into()))?;

        // SAFETY: the mutex is held for the whole configure-and-render sequence.
        unsafe {
            inner.filter.setScaleFactor(scale);
            // Sharpen only where the radius survives the scale (loupe, export); previews downsample it away while paying its cost.
            if inner.filter.isSharpnessSupported() {
                inner
                    .filter
                    .setSharpnessAmount(if scale >= 0.5 { self.sharpness } else { 0.0 });
            }
            // White balance goes to the decoder, not the output: it belongs before demosaicing.
            inner
                .filter
                .setNeutralTemperature(req.white_balance.temperature);
            inner.filter.setNeutralTint(req.white_balance.tint);

            let image = inner
                .filter
                .outputImage()
                .ok_or_else(|| SceneError::Render("RAW decoder produced no image".into()))?;
            let full: CGRect = image.extent();
            if full.size.width < 1.0 || full.size.height < 1.0 {
                return Err(SceneError::Render("empty render extent".into()));
            }

            // Core Image's origin is bottom-left, the region is top-down: y is measured from the far edge.
            let extent = if region.is_full() {
                full
            } else {
                let w = (f64::from(region.width) * full.size.width).max(1.0);
                let h = (f64::from(region.height) * full.size.height).max(1.0);
                let x = full.origin.x + f64::from(region.x) * full.size.width;
                let y = full.origin.y + (1.0 - f64::from(region.y + region.height)) as f64
                    * full.size.height;
                CGRect {
                    origin: objc2_core_foundation::CGPoint { x: x.round(), y: y.round() },
                    size: objc2_core_foundation::CGSize { width: w.round(), height: h.round() },
                }
            };
            let width = extent.size.width as u32;
            let height = extent.size.height as u32;
            if width == 0 || height == 0 {
                return Err(SceneError::Render("empty render extent".into()));
            }

            let colour_space = CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB))
                .ok_or_else(|| SceneError::Render("no linear colour space".into()))?;

            // Extended-linear sRGB keeps values above 1.0 instead of clipping — the highlight headroom.
            let pixels = (width as usize) * (height as usize);
            let mut rgba = vec![0f32; pixels * 4];
            inner.context.render_toBitmap_rowBytes_bounds_format_colorSpace(
                &image,
                NonNull::new(rgba.as_mut_ptr().cast::<c_void>())
                    .ok_or_else(|| SceneError::Render("null bitmap buffer".into()))?,
                (width as usize * 4 * std::mem::size_of::<f32>()) as isize,
                extent,
                kCIFormatRGBAf,
                Some(&colour_space),
            );

            // Alpha (constant 1.0 for RAW) is dropped in place: a second buffer would put ~700 MB
            // in flight at export size, and the destination index always trails the source.
            let mut rgba = rgba;
            for i in 0..pixels {
                let (src, dst) = (i * 4, i * 3);
                rgba[dst] = rgba[src];
                rgba[dst + 1] = rgba[src + 1];
                rgba[dst + 2] = rgba[src + 2];
            }
            rgba.truncate(pixels * 3);
            rgba.shrink_to_fit();

            Ok(LinearImage {
                width,
                height,
                rgb: rgba,
            })
        }
    }
}
