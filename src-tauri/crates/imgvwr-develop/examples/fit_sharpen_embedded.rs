//! How much unsharp the raw path needs to match the camera's own JPEG, using the JPEG embedded
//! in the raw as the reference (no sibling file needed). Renders a 1:1 centre patch through the
//! app's raw path with the measured look but no sharpening, then sweeps guided-filter luma NR × unsharp (radius × amount)
//! on the gamma-encoded output; scores busy-area edge energy against the camera (hf_ratio, 1 = match).
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example fit_sharpen_embedded -- *.CR2
//! ```

use std::path::Path;
use std::sync::Arc;

use imgvwr_core::{srgb_to_linear, ImageCrateFormat, Region, RenderRequest, SceneRegistry};
use imgvwr_develop::{opening_settings, render_looked, LookTuning, Overlay};

const PATCH: usize = 768;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let registry = SceneRegistry::new(vec![
        Arc::from(imgvwr_raw::raw_format()),
        Arc::new(ImageCrateFormat::new()),
    ]);
    for f in &files {
        if let Err(e) = run_one(&registry, Path::new(f)) {
            eprintln!("skipped {f}: {e}");
        }
    }
}

fn run_one(registry: &SceneRegistry, raw: &Path) -> Result<(), String> {
    let jpeg = imgvwr_raw::embedded_jpeg(raw).ok_or("no embedded JPEG")?;
    let jpeg = image::load_from_memory(&jpeg).map_err(|e| e.to_string())?.to_rgb8();
    // Embedded previews are stored unrotated; the scene is already oriented.
    let orientation = imgvwr_core::read_meta(raw).ok().and_then(|m| m.exif).map_or(1, |e| e.orientation);
    let jpeg = match orientation {
        6 => image::imageops::rotate90(&jpeg),
        8 => image::imageops::rotate270(&jpeg),
        3 => image::imageops::rotate180(&jpeg),
        _ => jpeg,
    };
    let scene = registry.open(raw).map_err(|e| format!("{e:?}"))?;
    let (nw, nh) = scene.native_size();
    // The camera JPEG may be larger than the raw (Canon mRAW); compare at the raw's size.
    let cam_full = image::imageops::resize(&jpeg, nw, nh, image::imageops::FilterType::Lanczos3);
    let (px, py) = ((nw as usize - PATCH) / 2, (nh as usize - PATCH) / 2);
    let mut cam = vec![0f32; PATCH * PATCH];
    for y in 0..PATCH {
        for x in 0..PATCH {
            let p = cam_full.get_pixel((px + x) as u32, (py + y) as u32);
            cam[y * PATCH + x] = luma_lin(p[0], p[1], p[2]);
        }
    }

    let iso = imgvwr_core::read_meta(raw).ok().and_then(|m| m.exif).and_then(|e| e.iso);
    let as_shot = scene.as_shot();
    let measure = scene
        .render(RenderRequest { max_edge: 384, white_balance: as_shot, region: Region::FULL })
        .map_err(|e| format!("{e:?}"))?;
    let decisions = imgvwr_core::read_camera_decisions(raw);
    let mut tuning = LookTuning::measure(&measure, iso, as_shot, &decisions);
    let shipped = tuning.sharpen;
    tuning.sharpen = 0.0;

    let settings = opening_settings(as_shot, scene.rendering());
    let region = Region {
        x: px as f32 / nw as f32,
        y: py as f32 / nh as f32,
        width: PATCH as f32 / nw as f32,
        height: PATCH as f32 / nh as f32,
    };
    let name = raw.file_stem().unwrap_or_default().to_string_lossy();
    for luma_nr in [0.0f32, 0.5, 1.0] {
        tuning.luma_nr = luma_nr;
        let base = render_looked(scene.as_ref(), &settings, PATCH as u32, Overlay::None, region, Some(&tuning))
            .map_err(|e| format!("{e:?}"))?
            .image;
        let (w, h) = (base.width as usize, base.height as usize);
        if w != PATCH || h != PATCH {
            return Err(format!("patch came back {w}x{h}"));
        }
        let enc: Vec<[f32; 3]> = base
            .rgba
            .chunks_exact(4)
            .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
            .collect();
        for r in [1usize, 2, 3] {
            for amount in [0.0f32, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0] {
                if amount == 0.0 && r > 1 {
                    continue;
                }
                let ours = unsharp(&enc, w, h, r, amount);
                let (score, noise, hf) = compare(&ours, &cam);
                println!(
                    "{{\"file\":\"{name}\",\"iso\":{},\"native\":[{nw},{nh}],\"shipped_sharpen\":{shipped:.2},\
                     \"luma_nr\":{luma_nr},\"r\":{r},\"amount\":{amount},\"score\":{score:.5},\"noise_ratio\":{noise:.3},\"hf_ratio\":{hf:.3}}}",
                    iso.unwrap_or(0)
                );
            }
        }
    }
    Ok(())
}

fn luma_lin(r: u8, g: u8, b: u8) -> f32 {
    let l = |v: u8| srgb_to_linear(v as f32 / 255.0);
    0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b)
}

/// The shipped stage's formula (nr.rs) with radius and amount free; returns linear luma.
fn unsharp(enc: &[[f32; 3]], w: usize, h: usize, r: usize, amount: f32) -> Vec<f32> {
    let y: Vec<f32> = enc.iter().map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).collect();
    let bl = box_mean(&y, w, h, r);
    enc.iter()
        .zip(y.iter().zip(&bl))
        .map(|(p, (yy, b))| {
            let gain = if *yy > 1e-6 { (1.0 + amount * (yy - b) / yy.max(0.02)).clamp(0.2, 3.0) } else { 1.0 };
            let c = |v: f32| srgb_to_linear((v * gain).clamp(0.0, 1.0));
            0.2126 * c(p[0]) + 0.7152 * c(p[1]) + 0.0722 * c(p[2])
        })
        .collect()
}

fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            tmp[y * w + x] = src[y * w + a..=y * w + b].iter().sum::<f32>() / (b - a + 1) as f32;
        }
    }
    for y in 0..h {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            out[y * w + x] = (a..=b).map(|yy| tmp[yy * w + x]).sum::<f32>() / (b - a + 1) as f32;
        }
    }
    out
}

/// fit_detail's metric: locally normalised luma, best integer alignment, edge energy split by the camera's gradient quartiles.
fn compare(a: &[f32], b: &[f32]) -> (f32, f32, f32) {
    let n = PATCH;
    let ma = box_mean(a, n, n, 8);
    let mb = box_mean(b, n, n, 8);
    let da: Vec<f32> = a.iter().zip(&ma).map(|(x, m)| x / (m + 0.002) - 1.0).collect();
    let db: Vec<f32> = b.iter().zip(&mb).map(|(x, m)| x / (m + 0.002) - 1.0).collect();
    let mut best = (0isize, 0isize, f32::INFINITY);
    for dy in -14isize..=14 {
        for dx in -14isize..=14 {
            let (mut sum, mut cnt) = (0f32, 0u32);
            for y in (32..n - 32).step_by(5) {
                for x in (32..n - 32).step_by(5) {
                    let ai = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
                    sum += (da[ai] - db[y * n + x]).abs();
                    cnt += 1;
                }
            }
            if sum / (cnt as f32) < best.2 {
                best = (dx, dy, sum / cnt as f32);
            }
        }
    }
    let (dx, dy, score) = best;
    let grad = |v: &[f32], i: usize| (v[i + 1] - v[i]).abs() + (v[i + n] - v[i]).abs();
    let mut grads = Vec::new();
    for y in (32..n - 33).step_by(3) {
        for x in (32..n - 33).step_by(3) {
            grads.push(grad(&db, y * n + x));
        }
    }
    grads.sort_by(|p, q| p.total_cmp(q));
    let (q1, q3) = (grads[grads.len() / 4], grads[3 * grads.len() / 4]);
    let (mut fa, mut fb, mut ba, mut bb) = (0f64, 0f64, 0f64, 0f64);
    for y in (32..n - 33).step_by(3) {
        for x in (32..n - 33).step_by(3) {
            let bi = y * n + x;
            let ai = (y as isize + dy) as usize * n + (x as isize + dx) as usize;
            let g = grad(&db, bi);
            let ea = grad(&da, ai) as f64;
            if g <= q1 {
                fa += ea;
                fb += g as f64;
            } else if g >= q3 {
                ba += ea;
                bb += g as f64;
            }
        }
    }
    (score, (fa / fb.max(1e-9)) as f32, (ba / bb.max(1e-9)) as f32)
}
