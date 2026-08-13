//! The built-in [`SceneFormat`] for ordinary formats — whatever the codec
//! registry can decode (JPEG, PNG, WebP, GIF).
//!
//! These files are already demosaiced, already white-balanced and already
//! gamma-encoded, so this plugin's job is the inverse of a RAW plugin's: undo
//! the sRGB transfer function to get back to linear light, and treat white
//! balance as a chromatic adaptation away from the D65 the file was encoded
//! against. It is an approximation of what a RAW plugin does properly, but it
//! is the honest best available for an 8-bit delivery file — and it means the
//! develop panel behaves identically no matter what the user opened.

use std::path::Path;

use crate::codec::CodecRegistry;
use crate::scene::{
    srgb_to_linear, white_balance_gains, LinearImage, Rendering, RenderRequest, SceneError,
    SceneFormat, SceneImage, WhiteBalance,
};
use crate::thumbs::{apply_orientation, exif_orientation, thumb_dimensions};

pub struct ImageCrateFormat {
    codecs: CodecRegistry,
}

impl Default for ImageCrateFormat {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageCrateFormat {
    pub fn new() -> Self {
        Self {
            codecs: CodecRegistry::builtin(),
        }
    }
}

/// A scene over pixels that were decoded — or synthesised — elsewhere.
///
/// The HDR merge hands its fused picture here, so a photograph that exists
/// only in memory develops exactly like a JPEG on disk would: same
/// linearisation, same white balance model, same everything downstream.
pub fn scene_from_rgba(img: image::RgbaImage) -> Box<dyn SceneImage> {
    Box::new(ImageCrateScene {
        width: img.width(),
        height: img.height(),
        rgba: img.into_raw(),
    })
}

/// A scene over scene-linear float pixels synthesised elsewhere — the HDR
/// radiance merge.
///
/// Scene-referred on purpose: this is measured light, not a finished
/// picture, so the develop pipeline chooses a look for it and the ordinary
/// tone controls work the full measured range. `1.0` is diffuse white and
/// the headroom above it is real — which is precisely what makes the
/// sliders HDR knobs rather than curve-benders over an 8-bit blend.
pub fn scene_from_radiance(width: u32, height: u32, rgb: Vec<f32>) -> Box<dyn SceneImage> {
    Box::new(RadianceScene { width, height, rgb })
}

struct RadianceScene {
    width: u32,
    height: u32,
    rgb: Vec<f32>,
}

impl SceneImage for RadianceScene {
    fn native_size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn rendering(&self) -> Rendering {
        Rendering::SceneReferred
    }

    fn as_shot(&self) -> WhiteBalance {
        // The radiance came from delivery files that were already
        // white-balanced against D65; the merge does not change that.
        WhiteBalance::D65
    }

    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError> {
        let (rx, ry, rw, rh) = req.region.to_pixels(self.width, self.height);
        let (dst_w, dst_h) = thumb_dimensions(rw, rh, req.max_edge.max(1));
        if dst_w == 0 || dst_h == 0 {
            return Err(SceneError::Render("empty image".into()));
        }
        let mut rgb = resample_area_f32(
            &self.rgb,
            self.width,
            (rx, ry, rw, rh),
            dst_w,
            dst_h,
        );

        let gains = white_balance_gains(self.as_shot(), req.white_balance);
        if gains != [1.0, 1.0, 1.0] {
            for px in rgb.chunks_exact_mut(3) {
                px[0] *= gains[0];
                px[1] *= gains[1];
                px[2] *= gains[2];
            }
        }

        Ok(LinearImage {
            width: dst_w,
            height: dst_h,
            rgb,
        })
    }

    fn neutral_at(
        &self,
        x: f32,
        y: f32,
        current: WhiteBalance,
    ) -> Result<WhiteBalance, SceneError> {
        crate::scene::neutral_by_measurement(self, x, y, current)
    }
}

/// Area-average downscale of already-linear samples: the float sibling of
/// [`resample_to_linear`], with no transfer function to undo.
fn resample_area_f32(
    rgb: &[f32],
    src_w: u32,
    region: (u32, u32, u32, u32),
    dst_w: u32,
    dst_h: u32,
) -> Vec<f32> {
    let stride = src_w as usize;
    let (rx, ry, rw, rh) = (
        region.0 as usize,
        region.1 as usize,
        region.2 as usize,
        region.3 as usize,
    );
    let (dw, dh) = (dst_w as usize, dst_h as usize);
    let mut out = vec![0f32; dw * dh * 3];

    for dy in 0..dh {
        let y0 = dy * rh / dh;
        let y1 = (((dy + 1) * rh).div_ceil(dh)).min(rh).max(y0 + 1);
        for dx in 0..dw {
            let x0 = dx * rw / dw;
            let x1 = (((dx + 1) * rw).div_ceil(dw)).min(rw).max(x0 + 1);
            let (mut r, mut g, mut b) = (0f32, 0f32, 0f32);
            for y in y0..y1 {
                let row = ((ry + y) * stride + rx) * 3;
                for x in x0..x1 {
                    let px = row + x * 3;
                    r += rgb[px];
                    g += rgb[px + 1];
                    b += rgb[px + 2];
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            let o = (dy * dw + dx) * 3;
            out[o] = r / n;
            out[o + 1] = g / n;
            out[o + 2] = b / n;
        }
    }
    out
}

impl SceneFormat for ImageCrateFormat {
    fn id(&self) -> &'static str {
        "image-crate"
    }

    fn probe(&self, ext: &str, magic: &[u8]) -> bool {
        self.codecs.find(ext, magic).is_some()
    }

    fn open(&self, path: &Path) -> Result<Box<dyn SceneImage>, SceneError> {
        let bytes = std::fs::read(path).map_err(|e| SceneError::Open(e.to_string()))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let decoded = self
            .codecs
            .decode(&ext, &bytes)
            .map_err(|e| SceneError::Open(e.to_string()))?;

        let img = image::RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
            .ok_or_else(|| SceneError::Open("pixel buffer size mismatch".into()))?;
        let img = apply_orientation(img, exif_orientation(&bytes));

        Ok(Box::new(ImageCrateScene {
            width: img.width(),
            height: img.height(),
            // Kept 8-bit on purpose: the source has no more precision than
            // this, and a full-resolution float buffer would cost ~290 MB for
            // a 24 MP file. Linearisation happens during resampling instead.
            rgba: img.into_raw(),
        }))
    }
}

struct ImageCrateScene {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl SceneImage for ImageCrateScene {
    fn native_size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn rendering(&self) -> Rendering {
        // A JPEG or PNG is somebody's finished picture; the look was chosen
        // when the file was written.
        Rendering::AlreadyRendered
    }

    fn as_shot(&self) -> WhiteBalance {
        // A delivery file carries no camera white balance to recover; it was
        // encoded against D65 and that is the neutral the UI starts from.
        WhiteBalance::D65
    }

    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError> {
        let (rx, ry, rw, rh) = req.region.to_pixels(self.width, self.height);
        let (dst_w, dst_h) = thumb_dimensions(rw, rh, req.max_edge.max(1));
        if dst_w == 0 || dst_h == 0 {
            return Err(SceneError::Render("empty image".into()));
        }
        let mut rgb = resample_to_linear(
            &self.rgba,
            self.width,
            self.height,
            (rx, ry, rw, rh),
            dst_w,
            dst_h,
        );

        let gains = white_balance_gains(self.as_shot(), req.white_balance);
        if gains != [1.0, 1.0, 1.0] {
            for px in rgb.chunks_exact_mut(3) {
                px[0] *= gains[0];
                px[1] *= gains[1];
                px[2] *= gains[2];
            }
        }

        Ok(LinearImage {
            width: dst_w,
            height: dst_h,
            rgb,
        })
    }

    fn neutral_at(
        &self,
        x: f32,
        y: f32,
        current: WhiteBalance,
    ) -> Result<WhiteBalance, SceneError> {
        crate::scene::neutral_by_measurement(self, x, y, current)
    }
}

/// 256-entry sRGB→linear lookup: the transfer function is the hot path of
/// every resample, and an 8-bit source only has 256 distinct inputs.
fn srgb_lut() -> [f32; 256] {
    let mut lut = [0f32; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        *slot = srgb_to_linear(i as f32 / 255.0);
    }
    lut
}

/// Area-average downscale that converts to linear light *during* accumulation.
///
/// Averaging gamma-encoded values (what a naive resize does) darkens detailed
/// regions; doing it in linear light is correct and costs nothing extra here,
/// because the conversion is a table lookup we have to do anyway.
fn resample_to_linear(
    rgba: &[u8],
    src_w: u32,
    src_h: u32,
    region: (u32, u32, u32, u32),
    dst_w: u32,
    dst_h: u32,
) -> Vec<f32> {
    let lut = srgb_lut();
    let stride = src_w as usize;
    let (rx, ry, rw, rh) = (
        region.0 as usize,
        region.1 as usize,
        region.2 as usize,
        region.3 as usize,
    );
    let _ = src_h;
    let (dw, dh) = (dst_w as usize, dst_h as usize);
    let mut out = vec![0f32; dw * dh * 3];

    if dw == rw && dh == rh {
        for dy in 0..dh {
            for dx in 0..dw {
                let px = ((ry + dy) * stride + rx + dx) * 4;
                let o = (dy * dw + dx) * 3;
                out[o] = lut[rgba[px] as usize];
                out[o + 1] = lut[rgba[px + 1] as usize];
                out[o + 2] = lut[rgba[px + 2] as usize];
            }
        }
        return out;
    }

    for dy in 0..dh {
        // Source row span (within the region) covered by this output row.
        let y0 = dy * rh / dh;
        let y1 = (((dy + 1) * rh).div_ceil(dh)).min(rh).max(y0 + 1);
        for dx in 0..dw {
            let x0 = dx * rw / dw;
            let x1 = (((dx + 1) * rw).div_ceil(dw)).min(rw).max(x0 + 1);
            let (mut r, mut g, mut b) = (0f32, 0f32, 0f32);
            for y in y0..y1 {
                let row = (ry + y) * stride;
                for x in x0..x1 {
                    let px = (row + rx + x) * 4;
                    r += lut[rgba[px] as usize];
                    g += lut[rgba[px + 1] as usize];
                    b += lut[rgba[px + 2] as usize];
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            let o = (dy * dw + dx) * 3;
            out[o] = r / n;
            out[o + 1] = g / n;
            out[o + 2] = b / n;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::linear_to_srgb;

    fn solid(w: u32, h: u32, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect()
    }

    #[test]
    fn resample_preserves_a_solid_colour() {
        let src = solid(8, 8, [128, 64, 32, 255]);
        let out = resample_to_linear(&src, 8, 8, (0, 0, 8, 8), 2, 2);
        assert_eq!(out.len(), 2 * 2 * 3);
        let expect = srgb_to_linear(128.0 / 255.0);
        for px in out.chunks_exact(3) {
            assert!((px[0] - expect).abs() < 1e-5, "{px:?}");
        }
    }

    #[test]
    fn resample_averages_in_linear_light_not_gamma() {
        // Half black, half white: the linear mean is 0.5, which re-encodes to
        // ~0.735 in sRGB — visibly brighter than the naive 0.5 a gamma-space
        // average would give. This is the whole point of the LUT.
        let src: Vec<u8> = [[0u8, 0, 0, 255], [255, 255, 255, 255]]
            .iter()
            .flatten()
            .copied()
            .collect();
        let out = resample_to_linear(&src, 2, 1, (0, 0, 2, 1), 1, 1);
        assert!((out[0] - 0.5).abs() < 1e-4, "linear mean: {}", out[0]);
        let encoded = linear_to_srgb(out[0]);
        assert!((encoded - 0.735).abs() < 0.01, "encoded: {encoded}");
    }

    #[test]
    fn identity_resample_takes_the_fast_path() {
        let src = solid(3, 2, [10, 20, 30, 255]);
        let out = resample_to_linear(&src, 3, 2, (0, 0, 3, 2), 3, 2);
        assert_eq!(out.len(), 3 * 2 * 3);
        assert!((out[1] - srgb_to_linear(20.0 / 255.0)).abs() < 1e-6);
    }

    #[test]
    fn scene_reports_native_size_and_d65() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.png");
        image::DynamicImage::new_rgb8(40, 20).save(&path).unwrap();

        let scene = ImageCrateFormat::new().open(&path).unwrap();
        assert_eq!(scene.native_size(), (40, 20));
        assert_eq!(scene.as_shot(), WhiteBalance::D65);
    }

    #[test]
    fn render_honours_the_size_cap_and_never_upscales() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.png");
        image::DynamicImage::new_rgb8(40, 20).save(&path).unwrap();
        let scene = ImageCrateFormat::new().open(&path).unwrap();

        let small = scene
            .render(RenderRequest {
                max_edge: 10,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region::FULL,
            })
            .unwrap();
        assert_eq!((small.width, small.height), (10, 5));
        assert_eq!(small.rgb.len(), small.pixel_count() * 3);

        let capped = scene
            .render(RenderRequest {
                max_edge: 4000,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region::FULL,
            })
            .unwrap();
        assert_eq!((capped.width, capped.height), (40, 20));
    }

    #[test]
    fn rendering_a_region_develops_only_that_crop() {
        // Left half black, right half white. Asking for the right half must
        // come back white, at the size of the crop rather than the frame.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("split.png");
        let mut img = image::RgbImage::new(80, 20);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 40 {
                image::Rgb([0, 0, 0])
            } else {
                image::Rgb([255, 255, 255])
            };
        }
        image::DynamicImage::ImageRgb8(img).save(&path).unwrap();
        let scene = ImageCrateFormat::new().open(&path).unwrap();

        let right = scene
            .render(RenderRequest {
                max_edge: 40,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region {
                    x: 0.5,
                    y: 0.0,
                    width: 0.5,
                    height: 1.0,
                },
            })
            .unwrap();
        assert_eq!((right.width, right.height), (40, 20), "crop, not frame");
        assert!(right.rgb.iter().all(|v| *v > 0.9), "all white: {:?}", &right.rgb[..3]);

        let left = scene
            .render(RenderRequest {
                max_edge: 40,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region {
                    x: 0.0,
                    y: 0.0,
                    width: 0.5,
                    height: 1.0,
                },
            })
            .unwrap();
        assert!(left.rgb.iter().all(|v| *v < 0.01), "all black");
    }

    #[test]
    fn a_region_at_native_scale_is_not_downsampled() {
        // The 1:1 case: a small crop asked for at its own size comes back
        // pixel-for-pixel, which is the whole point of region rendering.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        image::DynamicImage::new_rgb8(2000, 1000).save(&path).unwrap();
        let scene = ImageCrateFormat::new().open(&path).unwrap();

        let crop = scene
            .render(RenderRequest {
                max_edge: 400,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region {
                    x: 0.25,
                    y: 0.25,
                    width: 0.1,
                    height: 0.1,
                },
            })
            .unwrap();
        // 10% of 2000 = 200 px wide, under the 400 cap, so no scaling.
        assert_eq!((crop.width, crop.height), (200, 100));
    }

    #[test]
    fn render_applies_white_balance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grey.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            4,
            4,
            image::Rgb([128, 128, 128]),
        ))
        .save(&path)
        .unwrap();
        let scene = ImageCrateFormat::new().open(&path).unwrap();

        let neutral = scene
            .render(RenderRequest {
                max_edge: 4,
                white_balance: WhiteBalance::D65,
                region: crate::scene::Region::FULL,
            })
            .unwrap();
        assert!((neutral.rgb[0] - neutral.rgb[2]).abs() < 1e-5, "grey stays grey");

        let warm = scene
            .render(RenderRequest {
                max_edge: 4,
                white_balance: WhiteBalance {
                    temperature: 9000.0,
                    tint: 0.0,
                },
                region: crate::scene::Region::FULL,
            })
            .unwrap();
        assert!(warm.rgb[0] > warm.rgb[2], "warm render is red-heavy");
    }
}
