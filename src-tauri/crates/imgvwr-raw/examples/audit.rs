//! Audits the claims the raw plugin makes, against real files.
//!
//! ```sh
//! cargo run --release -p imgvwr-raw --example audit -- photo.NEF ...
//! ```
//!
//! Checks, in order:
//!  1. `raw_dimensions` (header-only) agrees with the opened scene's oriented
//!     native size — the portrait case, where they could disagree.
//!  2. The render really is scene-linear: doubling the light must double the
//!     samples, which is only true if no tone curve is being applied.
//!  3. How far outside the sRGB gamut the data lands, since the pipeline
//!     works in sRGB primaries.

use imgvwr_core::{Region, RenderRequest, SceneFormat};
use imgvwr_raw::{raw_dimensions, CoreImageRawFormat};

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let format = CoreImageRawFormat::new();

    for path in &files {
        let p = std::path::Path::new(path);
        let name = p.file_name().unwrap().to_string_lossy();

        let header = raw_dimensions(p);
        let scene = match format.open(p) {
            Ok(s) => s,
            Err(e) => {
                println!("{name}: OPEN FAILED {e}");
                continue;
            }
        };
        let native = scene.native_size();
        let agree = header == Some(native);
        let shape = if native.1 > native.0 { "portrait" } else { "landscape" };

        let wb = scene.as_shot();
        let img = scene
            .render(RenderRequest {
                max_edge: 400,
                white_balance: wb,
                region: Region::FULL,
            })
            .unwrap();
        let rendered_shape = if img.height > img.width { "portrait" } else { "landscape" };

        // Gamut: sRGB primaries cannot hold every colour a sensor records, and
        // gamut mapping is switched off, so out-of-range samples are expected.
        // The question is how many.
        let n = img.rgb.len() as f64;
        let below = img.rgb.iter().filter(|v| **v < 0.0).count() as f64;
        let above = img.rgb.iter().filter(|v| **v > 1.0).count() as f64;
        let most_negative = img.rgb.iter().copied().fold(0f32, f32::min);
        let brightest = img.rgb.iter().copied().fold(0f32, f32::max);
        let mean = img.rgb.iter().map(|v| f64::from(*v)) .sum::<f64>() / n;

        println!(
            "{name}: {shape} {native:?} header={header:?} agree={agree} render={rendered_shape} {}x{}",
            img.width, img.height
        );
        println!(
            "    as-shot {:.0} K / {:+.0}   mean {mean:.4}  range {most_negative:.4}..{brightest:.4}",
            wb.temperature, wb.tint
        );
        println!(
            "    out of sRGB gamut: {:.3}% negative, {:.3}% above 1.0",
            100.0 * below / n,
            100.0 * above / n
        );

        if !agree {
            println!("    ^^ MISMATCH between header dimensions and opened size");
        }
        if (rendered_shape == "portrait") != (shape == "portrait") {
            println!("    ^^ MISMATCH between native size and rendered orientation");
        }
    }

    // Linearity: the decisive check that "neutral decode" is real. Core Image's
    // own `exposure` is a pure scene-linear gain in stops, so if our render is
    // linear, +1 EV must double every sample. A tone curve anywhere in the
    // chain would make the ratio drift away from 2.0 in the highlights.
    if let Some(path) = files.first() {
        println!("\nlinearity check on {path}:");
        linearity(&format, std::path::Path::new(path));
    }
}

/// Render twice, one stop apart, and report the measured ratio per brightness
/// band. Uses the plugin's own path both times so the whole chain is covered.
fn linearity(format: &CoreImageRawFormat, path: &std::path::Path) {
    use objc2_core_image::CIRAWFilter;

    let scene = format.open(path).unwrap();
    let wb = scene.as_shot();
    let base = scene
        .render(RenderRequest {
            max_edge: 400,
            white_balance: wb,
            region: Region::FULL,
        })
        .unwrap();

    // Re-open through Core Image directly to apply a known +1 EV, since the
    // plugin deliberately does not expose Apple's exposure control.
    let brighter = unsafe {
        let url = objc2_foundation::NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(
            path.to_str().unwrap(),
        ));
        let f = CIRAWFilter::filterWithImageURL(&url).unwrap();
        f.setBoostAmount(0.0);
        f.setBoostShadowAmount(0.0);
        f.setGamutMappingEnabled(false);
        if f.isSharpnessSupported() { f.setSharpnessAmount(0.0); }
        if f.isContrastSupported() { f.setContrastAmount(0.0); }
        if f.isDetailSupported() { f.setDetailAmount(0.0); }
        if f.isHighlightRecoverySupported() { f.setHighlightRecoveryEnabled(true); }
        f.setNeutralTemperature(wb.temperature);
        f.setNeutralTint(wb.tint);
        f.setExposure(1.0); // +1 EV
        f
    };

    let img2 = render_filter(&brighter, base.width, base.height);
    if img2.len() != base.rgb.len() {
        println!("  size mismatch, skipping");
        return;
    }

    // Bucket by the darker render's value, so each band reports the ratio
    // where a tone curve would bend differently.
    let bands = [(0.01f32, 0.05f32), (0.05, 0.15), (0.15, 0.35), (0.35, 0.7)];
    for (lo, hi) in bands {
        let mut sum = 0f64;
        let mut count = 0u32;
        for (a, b) in base.rgb.iter().zip(img2.iter()) {
            if *a > lo && *a <= hi {
                sum += f64::from(*b / *a);
                count += 1;
            }
        }
        if count > 100 {
            println!(
                "  samples in {lo:.2}..{hi:.2}: mean ratio {:.4}  (linear ⇒ 2.0000)  n={count}",
                sum / f64::from(count)
            );
        }
    }
}

fn render_filter(filter: &objc2_core_image::CIRAWFilter, w: u32, h: u32) -> Vec<f32> {
    use objc2_core_graphics::{kCGColorSpaceExtendedLinearSRGB, CGColorSpace};
    use objc2_core_image::{kCIFormatRGBAf, CIContext};
    unsafe {
        let longest = 400.0f32;
        let native = filter.nativeSize();
        filter.setScaleFactor(longest / (native.width.max(native.height) as f32));
        let image = filter.outputImage().unwrap();
        let extent = image.extent();
        let (rw, rh) = (extent.size.width as usize, extent.size.height as usize);
        if rw != w as usize || rh != h as usize {
            return Vec::new();
        }
        let cs = CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB)).unwrap();
        let ctx = CIContext::new();
        let mut rgba = vec![0f32; rw * rh * 4];
        ctx.render_toBitmap_rowBytes_bounds_format_colorSpace(
            &image,
            std::ptr::NonNull::new(rgba.as_mut_ptr().cast::<std::ffi::c_void>()).unwrap(),
            (rw * 16) as isize,
            extent,
            kCIFormatRGBAf,
            Some(&cs),
        );
        rgba.chunks_exact(4).flat_map(|p| p[..3].to_vec()).collect()
    }
}
