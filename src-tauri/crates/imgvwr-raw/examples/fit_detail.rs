//! Measures which decoder detail settings (noise reduction, sharpening)
//! make a 1:1 patch of our decode match the camera JPEG's own rendering.
//!
//! ```sh
//! cargo run --release -p imgvwr-raw --example fit_detail -- <raw-files...>
//! ```
//!
//! For every raw with a sibling JPEG: render the centre patch at 1:1 under a
//! grid of (luminance NR, colour NR, sharpness, detail) settings, align it to
//! the JPEG patch by integer shift, equalise local brightness (a 16 px box),
//! and score the remaining fine-structure difference. Tone is deliberately
//! divided out — the camera look handles tone; this measures texture: how
//! much noise survives and how edges are drawn.
//!
//! Prints one JSON line per (file, setting); pick winners per ISO offline.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

use imgvwr_core::srgb_to_linear;
use objc2_core_foundation::CGRect;
use objc2_core_graphics::{kCGColorSpaceExtendedLinearSRGB, CGColorSpace};
use objc2_core_image::{kCIFormatRGBAf, CIContext, CIRAWFilter};
use objc2_foundation::{NSString, NSURL};

const PATCH: usize = 768;

#[derive(Clone, Copy)]
struct Knobs {
    lnr: f32,
    cnr: f32,
    sharp: f32,
    detail: f32,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: fit_detail <raw-files...>");
        std::process::exit(2);
    }
    for arg in &args {
        if let Err(e) = run_one(Path::new(arg)) {
            eprintln!("skipped {arg}: {e}");
        }
    }
}

fn run_one(raw: &Path) -> Result<(), String> {
    let jpeg_path = sibling_jpeg(raw).ok_or("no sibling JPEG")?;
    let iso = imgvwr_core::read_meta(raw)
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso)
        .unwrap_or(0);

    // The camera JPEG's centre patch, linear luma + chroma.
    let jpeg = image::ImageReader::open(&jpeg_path)
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .to_rgb8();
    let (jw, jh) = (jpeg.width() as usize, jpeg.height() as usize);
    if jw < PATCH * 2 || jh < PATCH * 2 {
        return Err("JPEG too small".into());
    }
    let (jx, jy) = ((jw - PATCH) / 2, (jh - PATCH) / 2);
    let mut cam = vec![0f32; PATCH * PATCH * 3];
    for y in 0..PATCH {
        for x in 0..PATCH {
            let p = jpeg.get_pixel((jx + x) as u32, (jy + y) as u32);
            for c in 0..3 {
                cam[(y * PATCH + x) * 3 + c] = srgb_to_linear(p[c] as f32 / 255.0);
            }
        }
    }

    // SAFETY: plain message sends to a filter we own, one file at a time.
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(
            raw.to_str().ok_or("path not UTF-8")?,
        ));
        let filter = CIRAWFilter::filterWithImageURL(&url).ok_or("unsupported raw")?;
        filter.setBoostAmount(0.0);
        filter.setBoostShadowAmount(0.0);
        filter.setGamutMappingEnabled(false);
        if filter.isContrastSupported() {
            filter.setContrastAmount(0.0);
        }
        if filter.isLocalToneMapSupported() {
            filter.setLocalToneMapAmount(0.0);
        }

        let defaults = (
            filter.luminanceNoiseReductionAmount(),
            filter.colorNoiseReductionAmount(),
            filter.sharpnessAmount(),
            filter.detailAmount(),
        );
        println!(
            "{{\"file\":\"{}\",\"iso\":{iso},\"defaults\":[{},{},{},{}]}}",
            raw.file_stem().unwrap_or_default().to_string_lossy(),
            defaults.0,
            defaults.1,
            defaults.2,
            defaults.3
        );

        let context = CIContext::new();
        let native = filter.nativeSize();
        let (nw, nh) = (native.width as usize, native.height as usize);
        // Match the JPEG's centre by relative position: the raw's active area
        // is a few pixels larger than the JPEG's.
        let rx = ((nw as f32 - PATCH as f32) / 2.0) as usize;
        let ry = ((nh as f32 - PATCH as f32) / 2.0) as usize;

        let render = |k: Knobs| -> Result<Vec<f32>, String> {
            filter.setLuminanceNoiseReductionAmount(k.lnr);
            filter.setColorNoiseReductionAmount(k.cnr);
            if filter.isSharpnessSupported() {
                filter.setSharpnessAmount(k.sharp);
            }
            if filter.isDetailSupported() {
                filter.setDetailAmount(k.detail);
            }
            filter.setScaleFactor(1.0);
            let image = filter.outputImage().ok_or("no output")?;
            let full: CGRect = image.extent();
            let extent = CGRect {
                origin: objc2_core_foundation::CGPoint {
                    x: full.origin.x + rx as f64,
                    // Core Image origin is bottom-left.
                    y: full.origin.y + (nh - ry - PATCH) as f64,
                },
                size: objc2_core_foundation::CGSize {
                    width: PATCH as f64,
                    height: PATCH as f64,
                },
            };
            let colour_space = CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB))
                .ok_or("no colour space")?;
            let mut rgba = vec![0f32; PATCH * PATCH * 4];
            context.render_toBitmap_rowBytes_bounds_format_colorSpace(
                &image,
                NonNull::new(rgba.as_mut_ptr().cast::<c_void>()).ok_or("null")?,
                (PATCH * 4 * std::mem::size_of::<f32>()) as isize,
                extent,
                kCIFormatRGBAf,
                Some(&colour_space),
            );
            let mut rgb = vec![0f32; PATCH * PATCH * 3];
            for i in 0..PATCH * PATCH {
                rgb[i * 3] = rgba[i * 4];
                rgb[i * 3 + 1] = rgba[i * 4 + 1];
                rgb[i * 3 + 2] = rgba[i * 4 + 2];
            }
            Ok(rgb)
        };

        // Stage 1: noise settings with sharpening off; stage 2: sharpening
        // with the defaults' NR. Full cross product would quadruple the time
        // for interactions that stage 3 (winners crossed) captures anyway.
        let mut grid: Vec<Knobs> = Vec::new();
        for lnr in [0.0, defaults.0, 0.35, 0.7] {
            for cnr in [0.0, defaults.1, 1.0] {
                grid.push(Knobs { lnr, cnr, sharp: 0.0, detail: 0.0 });
            }
        }
        for sharp in [0.0, 0.2, 0.4, 0.7, 1.0] {
            for detail in [0.0, 0.4, 0.8] {
                grid.push(Knobs { lnr: defaults.0, cnr: defaults.1, sharp, detail });
            }
        }
        // The camera sharpens edges while smoothing flat areas, so the two
        // must be searched together, not only in isolation.
        for sharp in [0.4, 0.7, 1.0] {
            for lnr in [0.35, 0.7] {
                grid.push(Knobs { lnr, cnr: defaults.1, sharp, detail: 0.0 });
            }
        }
        // Measured against the fitted look, the camera still smooths MORE
        // than our decode from ISO ~1000 up (edge-energy ratio 0.72-0.80),
        // so probe the top of the NR range too.
        for lnr in [0.85, 1.0] {
            for sharp in [0.0, 0.4, 0.7] {
                grid.push(Knobs { lnr, cnr: defaults.1, sharp, detail: 0.0 });
            }
        }

        for k in grid {
            let ours = render(k)?;
            let (score, noise_ratio, hf_ratio) = compare(&ours, &cam);
            println!(
                "{{\"file\":\"{}\",\"iso\":{iso},\"k\":[{},{},{},{}],\"score\":{score:.5},\
                 \"noise_ratio\":{noise_ratio:.4},\"hf_ratio\":{hf_ratio:.4}}}",
                raw.file_stem().unwrap_or_default().to_string_lossy(),
                k.lnr,
                k.cnr,
                k.sharp,
                k.detail
            );
        }
    }
    Ok(())
}

/// Fine-structure difference between two linear patches, tone divided out.
///
/// Returns (score, noise_ratio, hf_ratio): score is the mean absolute
/// difference of locally-normalised luma after the best integer alignment;
/// noise_ratio compares high-frequency energy in the flattest quarter of the
/// patch (ours over camera's — above 1 we are noisier); hf_ratio the same in
/// the busiest quarter (below 1 we are softer than the camera's sharpening).
fn compare(ours: &[f32], cam: &[f32]) -> (f32, f32, f32) {
    let luma = |p: &[f32], i: usize| {
        0.2126 * p[i * 3] + 0.7152 * p[i * 3 + 1] + 0.0722 * p[i * 3 + 2]
    };
    let n = PATCH;
    let mut a = vec![0f32; n * n];
    let mut b = vec![0f32; n * n];
    for i in 0..n * n {
        a[i] = luma(ours, i).max(0.0);
        b[i] = luma(cam, i).max(0.0);
    }

    // Box blur for the local mean (two passes of a running box).
    let blur = |src: &[f32], radius: usize| -> Vec<f32> {
        let mut tmp = vec![0f32; n * n];
        let mut out = vec![0f32; n * n];
        for y in 0..n {
            let mut acc = 0f32;
            for x in 0..2 * radius + 1 {
                acc += src[y * n + x.min(n - 1)];
            }
            for x in 0..n {
                tmp[y * n + x] = acc / (2 * radius + 1) as f32;
                let add = (x + radius + 1).min(n - 1);
                let sub = x.saturating_sub(radius);
                acc += src[y * n + add] - src[y * n + sub];
            }
        }
        for x in 0..n {
            let mut acc = 0f32;
            for y in 0..2 * radius + 1 {
                acc += tmp[y.min(n - 1) * n + x];
            }
            for y in 0..n {
                out[y * n + x] = acc / (2 * radius + 1) as f32;
                let add = (y + radius + 1).min(n - 1);
                let sub = y.saturating_sub(radius);
                acc += tmp[add * n + x] - tmp[sub * n + x];
            }
        }
        out
    };

    let ma = blur(&a, 8);
    let mb = blur(&b, 8);
    let norm = |v: &[f32], m: &[f32]| -> Vec<f32> {
        v.iter()
            .zip(m)
            .map(|(x, mu)| x / (mu + 0.002) - 1.0)
            .collect()
    };
    let da = norm(&a, &ma);
    let db = norm(&b, &mb);

    // Best integer shift within ±6 px, searched on a decimated grid.
    let mut best = (0isize, 0isize, f32::INFINITY);
    // ±14: the raw active area is wider than the JPEG's by up to 8 px a side.
    for dy in -14isize..=14 {
        for dx in -14isize..=14 {
            let mut sum = 0f32;
            let mut cnt = 0u32;
            let mut y = 32usize;
            while y < n - 32 {
                let mut x = 32usize;
                while x < n - 32 {
                    let ai = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                    sum += (da[ai] - db[y * n + x]).abs();
                    cnt += 1;
                    x += 5;
                }
                y += 5;
            }
            let mean = sum / cnt as f32;
            if mean < best.2 {
                best = (dx, dy, mean);
            }
        }
    }
    let (dx, dy, score) = best;

    // Flat vs busy regions of the aligned pair, by the camera's local range.
    let grad = |v: &[f32], i: usize| -> f32 {
        (v[i + 1] - v[i]).abs() + (v[i + n] - v[i]).abs()
    };
    let mut flat_a = 0f64;
    let mut flat_b = 0f64;
    let mut busy_a = 0f64;
    let mut busy_b = 0f64;
    let mut grads: Vec<f32> = Vec::new();
    let mut y = 32;
    while y < n - 33 {
        let mut x = 32;
        while x < n - 33 {
            grads.push(grad(&db, y * n + x));
            x += 3;
        }
        y += 3;
    }
    grads.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
    let q1 = grads[grads.len() / 4];
    let q3 = grads[3 * grads.len() / 4];
    let mut y = 32;
    while y < n - 33 {
        let mut x = 32;
        while x < n - 33 {
            let bi = y * n + x;
            let ai = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
            let g = grad(&db, bi);
            let ea = grad(&da, ai) as f64;
            let eb = g as f64;
            if g <= q1 {
                flat_a += ea;
                flat_b += eb;
            } else if g >= q3 {
                busy_a += ea;
                busy_b += eb;
            }
            x += 3;
        }
        y += 3;
    }
    (
        score,
        (flat_a / flat_b.max(1e-9)) as f32,
        (busy_a / busy_b.max(1e-9)) as f32,
    )
}

fn sibling_jpeg(raw: &Path) -> Option<PathBuf> {
    for ext in ["JPG", "jpg", "JPEG", "jpeg"] {
        let candidate = raw.with_extension(ext);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
