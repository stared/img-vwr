//! Measures the camera look end to end: every raw with a sibling JPEG is
//! rendered the way the app now opens it (neutral decode → measured tuning →
//! camera look) and compared against the camera's own JPEG.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example verify_look -- <dir>...
//! ```

use std::path::{Path, PathBuf};

use imgvwr_core::{srgb_to_linear, Region, RenderRequest, SceneFormat};
use imgvwr_develop::{develop_looked, DevelopParams, LookTuning};
use imgvwr_raw::CoreImageRawFormat;
use rayon::prelude::*;

const GRID_EDGE: u32 = 384;
const BORDER: f32 = 0.06;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: verify_look <dir-or-raw-file>...");
        std::process::exit(2);
    }
    let raws = collect_raws(&args);
    println!("{} raw files", raws.len());

    let results: Vec<(String, f64)> = raws
        .par_iter()
        .filter_map(|raw| match measure_one(raw) {
            Ok(err) => {
                let folder = raw
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Some((folder, err))
            }
            Err(e) => {
                eprintln!("skipped {}: {e}", raw.display());
                None
            }
        })
        .collect();

    let mut folders: Vec<String> = results.iter().map(|(f, _)| f.clone()).collect();
    folders.sort();
    folders.dedup();
    let mut all = Vec::new();
    for folder in &folders {
        let errs: Vec<f64> = results
            .iter()
            .filter(|(f, _)| f == folder)
            .map(|(_, e)| *e)
            .collect();
        let mean = errs.iter().sum::<f64>() / errs.len() as f64;
        println!("{folder:32} n={:4}  mean |Δ| {mean:.2} sRGB units", errs.len());
        all.extend(errs);
    }
    println!(
        "overall {} pairs: mean |Δ| {:.2} sRGB units",
        all.len(),
        all.iter().sum::<f64>() / all.len().max(1) as f64
    );
}

fn measure_one(raw: &Path) -> Result<f64, String> {
    let jpeg = sibling_jpeg(raw).ok_or("no sibling JPEG")?;
    let opened = CoreImageRawFormat::new().open(raw).map_err(|e| e.to_string())?;
    let scene = opened
        .render(RenderRequest {
            max_edge: GRID_EDGE,
            white_balance: opened.as_shot(),
            region: Region::FULL,
        })
        .map_err(|e| e.to_string())?;

    let iso = imgvwr_core::read_meta(raw)
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso);
    let tuning = LookTuning::measure(&scene, iso, opened.as_shot());
    let ours = develop_looked(&scene, &DevelopParams::default(), Some(&tuning));

    let (w, h) = (scene.width as usize, scene.height as usize);
    let camera = jpeg_on_grid(&jpeg, w, h)?;

    let (mx, my) = ((w as f32 * BORDER) as usize, (h as f32 * BORDER) as usize);
    let mut sum = 0f64;
    let mut n = 0usize;
    for y in my..h - my {
        for x in mx..w - mx {
            let i = y * w + x;
            for c in 0..3 {
                let a = ours.rgba[i * 4 + c] as f64;
                let b = camera[i * 3 + c] as f64;
                sum += (a - b).abs();
                n += 1;
            }
        }
    }
    Ok(sum / n.max(1) as f64)
}

fn collect_raws(args: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for arg in args {
        let path = PathBuf::from(arg);
        if path.is_dir() {
            let mut found: Vec<PathBuf> = std::fs::read_dir(&path)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| imgvwr_raw::is_raw_extension(&e.to_ascii_lowercase()))
                        .unwrap_or(false)
                })
                .collect();
            found.sort();
            out.extend(found);
        } else {
            out.push(path);
        }
    }
    out
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

/// The camera JPEG oriented and box-averaged onto the raw grid, as sRGB u8.
fn jpeg_on_grid(path: &Path, tw: usize, th: usize) -> Result<Vec<u8>, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .to_rgb8();

    let orientation = imgvwr_core::read_meta(path)
        .ok()
        .and_then(|m| m.exif)
        .map(|e| e.orientation)
        .unwrap_or(1);
    let img = match orientation {
        6 => image::imageops::rotate90(&img),
        8 => image::imageops::rotate270(&img),
        3 => image::imageops::rotate180(&img),
        _ => img,
    };

    let (sw, sh) = (img.width() as usize, img.height() as usize);
    if sw == 0 || sh == 0 {
        return Err("empty JPEG".into());
    }
    let aspect = |w: usize, h: usize| w as f32 / h as f32;
    if (aspect(sw, sh) / aspect(tw, th) - 1.0).abs() > 0.02 {
        return Err("different framing".into());
    }

    let lut: Vec<f32> = (0..256).map(|i| srgb_to_linear(i as f32 / 255.0)).collect();
    let enc = |v: f32| -> u8 {
        (imgvwr_core::linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8
    };

    let mut out = vec![0u8; tw * th * 3];
    for ty in 0..th {
        let y0 = ty * sh / th;
        let y1 = ((ty + 1) * sh / th).max(y0 + 1);
        for tx in 0..tw {
            let x0 = tx * sw / tw;
            let x1 = ((tx + 1) * sw / tw).max(x0 + 1);
            let (mut r, mut g, mut b) = (0f32, 0f32, 0f32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = img.get_pixel(x as u32, y as u32);
                    r += lut[p[0] as usize];
                    g += lut[p[1] as usize];
                    b += lut[p[2] as usize];
                }
            }
            let count = ((x1 - x0) * (y1 - y0)) as f32;
            let i = (ty * tw + tx) * 3;
            out[i] = enc(r / count);
            out[i + 1] = enc(g / count);
            out[i + 2] = enc(b / count);
        }
    }
    Ok(out)
}
