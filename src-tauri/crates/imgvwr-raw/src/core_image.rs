//! `CIRAWFilter`-backed implementation of the RAW plugin (macOS).

use std::ffi::c_void;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Mutex;

use imgvwr_core::{LinearImage, RenderRequest, SceneError, SceneFormat, SceneImage, WhiteBalance};
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

        // SAFETY: every call below is a plain Objective-C message send to an
        // immutable-until-we-touch-it filter object we exclusively own.
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
            let filter = CIRAWFilter::filterWithImageURL(&url).ok_or_else(|| {
                SceneError::Open(format!(
                    "the system RAW decoder does not support {}",
                    path.display()
                ))
            })?;

            // Neutral decode. Apple's renderer would otherwise apply its own
            // look — a tone curve, shadow boost, capture sharpening — and the
            // develop sliders would then be stacking on top of an opinion the
            // user cannot see or undo.
            filter.setBoostAmount(0.0);
            filter.setBoostShadowAmount(0.0);
            filter.setGamutMappingEnabled(false);
            if filter.isSharpnessSupported() {
                filter.setSharpnessAmount(0.0);
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
            // Highlight recovery is not a look — it reconstructs channels the
            // sensor clipped, which is precisely what makes a highlights slider
            // able to recover anything at all.
            if filter.isHighlightRecoverySupported() {
                filter.setHighlightRecoveryEnabled(true);
            }

            let as_shot = WhiteBalance {
                temperature: filter.neutralTemperature(),
                tint: filter.neutralTint(),
            };

            // Ask for the oriented full-size extent once, here: it is what
            // forces the initial parse (~2 s for a 24 MP NEF), and doing it at
            // open time means every later render is the cheap ~8 ms path.
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
            }))
        }
    }
}

/// Frame size without decoding anything.
///
/// Creating the filter parses headers only — the expensive demosaic setup is
/// deferred until pixels are asked for — so this is cheap enough to run over
/// a whole folder during a metadata sweep, which is what makes raw files
/// sortable and filterable by size like every other format.
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
        // `nativeSize` is the sensor's own frame. EXIF orientations 5–8 are
        // the quarter turns, under which the photograph is the other way up.
        // Compared numerically so this file needs no Image I/O dependency
        // just to name the enum.
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
}

// SAFETY: `CIContext` is documented as thread-safe, and the filter is only
// ever reached through the mutex — which is required anyway, since rendering
// means mutating filter properties and then reading the result.
unsafe impl Send for CoreImageRawScene {}
unsafe impl Sync for CoreImageRawScene {}

impl SceneImage for CoreImageRawScene {
    fn native_size(&self) -> (u32, u32) {
        self.native
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
        // Core Image has a `neutralLocation` property that looks like exactly
        // the right tool, and measurably is not: setting it leaves
        // `neutralTemperature` and `neutralTint` untouched for every point
        // tried, before and after forcing a render. So the raw path measures
        // a developed patch like any other format.
        imgvwr_core::neutral_by_measurement(self, x, y, current)
    }

    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError> {
        let region = req.region.clamped();
        // Scale is chosen against the *requested region*, not the whole
        // frame: that is what lets a 1:1 look at a small crop cost a small
        // render rather than developing all 24 megapixels.
        let region_longest =
            (self.native.0 as f32 * region.width).max(self.native.1 as f32 * region.height);
        // Never upscale: asking for more than the sensor has just wastes time.
        let scale = (req.max_edge.max(1) as f32 / region_longest.max(1.0)).min(1.0);

        let inner = self
            .inner
            .lock()
            .map_err(|_| SceneError::Render("RAW decoder lock poisoned".into()))?;

        // SAFETY: exclusive access is held for the whole configure-and-render
        // sequence, so no other thread can observe a half-applied setting.
        unsafe {
            inner.filter.setScaleFactor(scale);
            // White balance goes to the decoder rather than being applied to
            // the output: it belongs before demosaicing, in sensor space.
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

            // Crop in the scaled output's own coordinates. Core Image's origin
            // is bottom-left while a region is stated top-down, so the y
            // offset is measured from the far edge.
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

            // Extended-linear sRGB keeps values above 1.0 instead of clipping
            // them, which is what leaves highlight headroom to recover.
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

            // Drop alpha: the develop pipeline is RGB, and for a RAW file the
            // alpha channel is a constant 1.0 anyway.
            //
            // Compacted within the same allocation rather than copied into a
            // second one. At full export size the buffer is ~390 MB, so a
            // copy would put nearly 700 MB in flight at once; the destination
            // index always trails the source, which makes this safe in place.
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
