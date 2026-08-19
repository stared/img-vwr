//! Audits the raw plugin's claims (dimensions, linearity, gamut, eyedropper) against real files.

use imgvwr_core::{Region, RenderRequest, SceneFormat, SceneImage, WhiteBalance};
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

        // Gamut mapping is off, so out-of-sRGB samples are expected; the question is how many.
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

    // CI's `exposure` is a pure linear gain in stops: if the render is linear, +1 EV doubles every sample; a tone curve anywhere would pull the ratio off 2.0.
    if let Some(path) = files.first() {
        println!("\nlinearity check on {path}:");
        linearity(&format, std::path::Path::new(path));

        println!("\neyedropper check on {path}:");
        eyedropper(&format, std::path::Path::new(path));
    }
}

/// Pick, apply, re-measure: Core Image applies the temperature with its own model, so only a re-render shows over/undershoot.
fn eyedropper(format: &CoreImageRawFormat, path: &std::path::Path) {
    let scene = format.open(path).unwrap();
    let as_shot = scene.as_shot();

    let cast = |rgb: [f32; 3]| {
        let max = rgb[0].max(rgb[1]).max(rgb[2]);
        let min = rgb[0].min(rgb[1]).min(rgb[2]);
        (max - min) / max.max(1e-6)
    };
    let patch_at = |x: f32, y: f32, wb: WhiteBalance| -> [f32; 3] {
        let img = scene
            .render(RenderRequest {
                max_edge: 1,
                white_balance: wb,
                region: Region {
                    x: x - 0.005,
                    y: y - 0.005,
                    width: 0.01,
                    height: 0.01,
                },
            })
            .unwrap();
        [img.rgb[0], img.rgb[1], img.rgb[2]]
    };

    // Only near-grey, properly exposed patches: black/blown ones measure rounding error, saturated ones can never be greyed.
    let candidates = neutral_candidates(&*scene, as_shot);
    let Some(&(px, py)) = candidates.first() else {
        println!("  no usable patch in this frame");
        return;
    };

    // The picker inverts the model, so a factor error here puts the same factor on every pick.
    let reference = patch_at(px, py, as_shot);
    println!("  our model's prediction against the decoder, at ({px:.2},{py:.2}):");
    for factor in [0.8f32, 0.9, 1.1, 1.25] {
        let target = WhiteBalance {
            temperature: as_shot.temperature * factor,
            tint: as_shot.tint,
        };
        let actual = patch_at(px, py, target);
        let gains = imgvwr_core::scene::white_balance_gains(as_shot, target);
        // Red over blue, green-normalised out: the axis temperature moves.
        let measured = (actual[0] / actual[2]) / (reference[0] / reference[2]);
        let predicted = gains[0] / gains[2];
        let strength = measured.ln() / predicted.ln();
        println!(
            "    {:>5.0} K   R/B moves ×{measured:.3}, model says ×{predicted:.3}   \
             (decoder is {strength:.2}× as strong){}",
            target.temperature,
            if strength <= 0.0 {
                "   WRONG DIRECTION"
            } else {
                ""
            }
        );
    }

    println!("  picking the most neutral patches in the frame:");
    for (x, y) in candidates {
        let before = patch_at(x, y, as_shot);
        let started = std::time::Instant::now();
        let picked = scene.neutral_at(x, y, as_shot).unwrap();
        let took = started.elapsed();
        let after = patch_at(x, y, picked);
        let (b, a) = (cast(before), cast(after));
        // Overshoot = a sign flip that is still visible; a flip within noise is just convergence.
        let flipped = (before[0] / before[2] > 1.0) != (after[0] / after[2] > 1.0);
        println!(
            "    ({x:.2},{y:.2}) {:.0} K → {:.0} K   cast {b:.3} → {a:.3}   {:>4} ms{}",
            as_shot.temperature,
            picked.temperature,
            took.as_millis(),
            if a > b {
                "   WORSE"
            } else if flipped && a > 0.02 {
                "   OVERSHOT (cast reversed)"
            } else {
                ""
            }
        );
    }
}

fn neutral_candidates(scene: &dyn SceneImage, wb: WhiteBalance) -> Vec<(f32, f32)> {
    let img = scene
        .render(RenderRequest {
            max_edge: 48,
            white_balance: wb,
            region: Region::FULL,
        })
        .unwrap();
    let mut scored: Vec<(f32, f32, f32)> = Vec::new();
    for (i, px) in img.rgb.chunks_exact(3).enumerate() {
        let y = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
        if !(0.05..0.5).contains(&y) {
            continue;
        }
        let max = px[0].max(px[1]).max(px[2]);
        let min = px[0].min(px[1]).min(px[2]);
        let (col, row) = (i as u32 % img.width, i as u32 / img.width);
        scored.push((
            (max - min) / max.max(1e-6),
            (col as f32 + 0.5) / img.width as f32,
            (row as f32 + 0.5) / img.height as f32,
        ));
    }
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(4).map(|(_, x, y)| (x, y)).collect()
}

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

    // Re-opened through Core Image directly: the plugin deliberately does not expose Apple's exposure control.
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

    // Banded by the darker render's value: a tone curve would bend each band differently.
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
