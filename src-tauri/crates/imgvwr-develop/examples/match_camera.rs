//! Fits develop settings that make a raw file look like the camera's own JPEG.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example match_camera -- ~/Pictures/Nikon_RAW/"20260802 bb"
//! ```
//!
//! The camera writes a JPEG beside every raw frame, rendered by its own
//! processing — a tone curve, a colour mode, some sharpening. Our decode is
//! deliberately neutral, so a fresh raw looks flat next to it. The question
//! "which settings get us back there" has a measurable answer whenever both
//! files exist, and this is the measurement:
//!
//!  1. Develop each raw at neutral, downsample the JPEG onto the same grid.
//!  2. Report the per-channel gain between them, which is white balance and
//!     colour matrix — the part sliders on tone cannot fix.
//!  3. Search the parameter space for the one setting that minimises the mean
//!     difference across every pair at once. That is the preset.
//!  4. Refit per image to show what the preset cannot capture, since a fixed
//!     setting cannot follow the camera's own per-frame decisions.
//!
//! Differences are reported in 8-bit sRGB units — the numbers you would read
//! off a pixel probe — because that is the space the eye compares in.

use std::path::{Path, PathBuf};

use imgvwr_core::{
    linear_to_srgb, srgb_to_linear, LinearImage, Region, RenderRequest, SceneFormat, WhiteBalance,
};
use imgvwr_develop::{develop, DevelopParams};
use imgvwr_raw::CoreImageRawFormat;
use rayon::prelude::*;

/// Long edge of the comparison grid. Small on purpose: the camera may correct
/// lens distortion where we do not, which misaligns edges by a few pixels at
/// full size. Downsampling makes the comparison about tone and colour rather
/// than about geometry.
const GRID_EDGE: u32 = 320;

/// Fraction of each edge ignored. Vignetting correction and distortion both do
/// their worst at the frame's rim.
const BORDER: f32 = 0.06;

struct Pair {
    name: String,
    width: usize,
    height: usize,
    /// Scene-linear pixels straight from the raw plugin, as-shot balance.
    scene: LinearImage,
    /// The camera's JPEG on the same grid, scene-linear.
    camera_linear: Vec<f32>,
    /// ...and as the display values the eye actually compares.
    camera_srgb: Vec<u8>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: match_camera <dir-or-raw-file>...");
        std::process::exit(2);
    }

    let raws = collect_raws(&args);
    let pairs = load_all(&raws, &|_, as_shot| as_shot);
    if pairs.is_empty() {
        eprintln!("no raw file had a sibling JPEG that could be read");
        std::process::exit(1);
    }
    println!("{} pairs, {GRID_EDGE} px grid\n", pairs.len());

    println!("── as shot ──");
    report_channel_gains(&pairs);

    let neutral = DevelopParams::default();
    let base = error(&pairs, &neutral);
    println!("neutral decode:   mean |Δ| {base:.2} sRGB units");
    let preset = fit(&pairs, neutral, &ALL_AXES);
    report_fit("tone preset", &pairs, &preset, base);
    report_per_image(&pairs, &preset);

    // The other half of a preset: white balance happens inside the decoder,
    // before demosaicing, so trying a different one means rendering again.
    //
    // Swept rather than solved. Solving would mean inverting our own
    // illuminant model to guess which temperature produces a wanted cast, and
    // that model does not agree with what Core Image actually does — it moves
    // colour about half again as far per kelvin. A sweep asks the decoder
    // instead of a model, so it cannot be wrong about the decoder.
    println!("\n── a fixed white-balance shift, swept ──");
    let mut best = (1.0f32, error(&pairs, &preset), preset);
    for factor in [1.03f32, 1.06, 1.09, 1.13] {
        let shifted = load_all(&raws, &|_, as_shot| WhiteBalance {
            temperature: as_shot.temperature * factor,
            tint: as_shot.tint,
        });
        let tuned = fit(&shifted, preset, &ALL_AXES);
        let err = error(&shifted, &tuned);
        println!("  temperature × {factor:.2}   mean |Δ| {err:.2}");
        if err < best.1 {
            best = (factor, err, tuned);
        }
    }
    println!(
        "  best: × {:.2} at {:.2}, against {:.2} for leaving the balance alone",
        best.0,
        best.1,
        error(&pairs, &preset)
    );

    println!("\n── where the preset still misses ──");
    report_transfer(&pairs, &preset);
    confirm_minimum(&pairs, &preset);
}

/// The tone relationship the preset is trying to reproduce, measured rather
/// than assumed: what the camera does to each brightness, beside what we do.
/// A preset that matches on average can still be wrong at both ends, and this
/// is where that shows.
fn report_transfer(pairs: &[Pair], params: &DevelopParams) {
    // Bins in stops around middle grey, which is how tone actually behaves.
    const STOPS: [f32; 8] = [-4.0, -3.0, -2.0, -1.0, 0.0, 1.0, 2.0, 3.0];
    let mut camera: Vec<Vec<f32>> = STOPS.iter().map(|_| Vec::new()).collect();
    let mut ours: Vec<Vec<f32>> = STOPS.iter().map(|_| Vec::new()).collect();

    for pair in pairs {
        let developed = develop(&pair.scene, params);
        for i in interior(pair) {
            let y = luma(&pair.scene.rgb[i * 3..i * 3 + 3]);
            if y <= 1e-5 {
                continue;
            }
            let stops = (y / imgvwr_develop::MID_GREY).log2();
            let Some(bin) = STOPS.iter().position(|s| (stops - s).abs() <= 0.5) else {
                continue;
            };
            camera[bin].push(luma_srgb(&pair.camera_srgb[i * 3..i * 3 + 3]));
            ours[bin].push(luma_srgb(&[
                developed.rgba[i * 4],
                developed.rgba[i * 4 + 1],
                developed.rgba[i * 4 + 2],
            ]));
        }
    }

    println!("  scene light      camera   preset    Δ");
    for (bin, stops) in STOPS.iter().enumerate() {
        if camera[bin].len() < 500 {
            continue;
        }
        let c = median(&mut camera[bin]);
        let o = median(&mut ours[bin]);
        println!("  {stops:+.0} EV of grey     {c:5.1}   {o:5.1}   {:+5.1}", o - c);
    }
}

/// Coordinate descent can stop early on a ridge, and a preset reported from a
/// premature stop would be a fiction. Nudging every axis proves it is not.
fn confirm_minimum(pairs: &[Pair], params: &DevelopParams) {
    // Anything under this is a difference nobody can see; reporting it as
    // "not converged" would be pedantry rather than a finding.
    const MEANINGFUL: f64 = 0.01;
    let here = error(pairs, params);
    let mut settled = true;
    for axis in &ALL_AXES {
        let nudge = if axis.name == "exposure" { 0.1 } else { 5.0 };
        for delta in [-nudge, nudge] {
            let mut trial = *params;
            let v = ((axis.get)(params) + delta).clamp(axis.min, axis.max);
            (axis.set)(&mut trial, v);
            let there = error(pairs, &trial);
            if there < here - MEANINGFUL {
                println!(
                    "  NOT converged: {} {v:+.2} is better by {:.3}",
                    axis.name,
                    here - there
                );
                settled = false;
            }
        }
    }
    if settled {
        println!("  converged: no slider improves the match by even {MEANINGFUL} of an sRGB unit");
    }
}

fn luma(rgb: &[f32]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

fn luma_srgb(rgb: &[u8]) -> f32 {
    0.2126 * rgb[0] as f32 + 0.7152 * rgb[1] as f32 + 0.0722 * rgb[2] as f32
}

fn report_fit(label: &str, pairs: &[Pair], params: &DevelopParams, base: f64) {
    let err = error(pairs, params);
    println!(
        "fitted {label}: mean |Δ| {err:.2}  ({:.0}% closer than a neutral decode)",
        (1.0 - err / base) * 100.0
    );
    print_params(label, params);
}

// ---------------------------------------------------------------- loading

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
                .filter(|p| is_raw(p))
                .collect();
            found.sort();
            out.extend(found);
        } else if is_raw(&path) {
            out.push(path);
        }
    }
    out
}

fn is_raw(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| imgvwr_raw::is_raw_extension(&e.to_ascii_lowercase()))
        .unwrap_or(false)
}

/// The camera's JPEG for a raw file — same stem, any of the usual spellings.
fn sibling_jpeg(raw: &Path) -> Option<PathBuf> {
    for ext in ["JPG", "jpg", "JPEG", "jpeg"] {
        let candidate = raw.with_extension(ext);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Renders every raw once, at whatever balance `adjust` derives from the
/// camera's own. Reloading rather than caching scenes: a raw file open holds
/// the decoder's working state for a 24 MP frame, and 50 of those at once is a
/// lot of memory to save a few seconds.
fn load_all(
    raws: &[PathBuf],
    adjust: &(dyn Fn(&Path, WhiteBalance) -> WhiteBalance + Sync),
) -> Vec<Pair> {
    raws.par_iter()
        .filter_map(|raw| match load_pair(raw, adjust) {
            Ok(pair) => Some(pair),
            Err(e) => {
                eprintln!("skipped {}: {e}", raw.display());
                None
            }
        })
        .collect()
}

fn load_pair(
    raw: &Path,
    adjust: &(dyn Fn(&Path, WhiteBalance) -> WhiteBalance + Sync),
) -> Result<Pair, String> {
    let jpeg = sibling_jpeg(raw).ok_or("no sibling JPEG")?;

    // The camera's own balance is the starting point, not a fixed illuminant:
    // the JPEG beside this file was rendered with it, so anything else would
    // show up as a colour difference that has nothing to do with the preset.
    let opened = CoreImageRawFormat::new().open(raw).map_err(|e| e.to_string())?;
    let as_shot = opened.as_shot();
    let scene = opened
        .render(RenderRequest {
            max_edge: GRID_EDGE,
            white_balance: adjust(raw, as_shot),
            region: Region::FULL,
        })
        .map_err(|e| e.to_string())?;

    let (w, h) = (scene.width as usize, scene.height as usize);
    let camera_linear = jpeg_on_grid(&jpeg, w, h)?;
    let camera_srgb = camera_linear
        .iter()
        .map(|v| (linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8)
        .collect();

    Ok(Pair {
        name: raw.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
        width: w,
        height: h,
        scene,
        camera_linear,
        camera_srgb,
    })
}

/// The camera JPEG, oriented like the raw render and box-averaged onto its
/// grid. Averaging happens in linear light: doing it on sRGB values darkens
/// every edge, which would then read as a tone difference that is really a
/// resampling mistake.
fn jpeg_on_grid(path: &Path, tw: usize, th: usize) -> Result<Vec<f32>, String> {
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
        return Err(format!(
            "JPEG is {sw}×{sh} but the raw renders {tw}×{th} — different framing"
        ));
    }

    // sRGB → linear once per source pixel, through a table: the loop below
    // touches 24 million of them per file.
    let lut: Vec<f32> = (0..256).map(|i| srgb_to_linear(i as f32 / 255.0)).collect();

    let mut out = vec![0f32; tw * th * 3];
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
            let n = ((x1 - x0) * (y1 - y0)) as f32;
            let i = (ty * tw + tx) * 3;
            out[i] = r / n;
            out[i + 1] = g / n;
            out[i + 2] = b / n;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- metric

/// Pixel indices the comparison uses — everything but the rim.
fn interior(pair: &Pair) -> impl Iterator<Item = usize> + '_ {
    let mx = (pair.width as f32 * BORDER) as usize;
    let my = (pair.height as f32 * BORDER) as usize;
    (my..pair.height - my).flat_map(move |y| (mx..pair.width - mx).map(move |x| y * pair.width + x))
}

/// Mean absolute difference in 8-bit sRGB units, averaged over every pair.
fn error(pairs: &[Pair], params: &DevelopParams) -> f64 {
    let (sum, count) = pairs
        .par_iter()
        .map(|pair| {
            let ours = develop(&pair.scene, params);
            let mut sum = 0f64;
            let mut n = 0usize;
            for i in interior(pair) {
                for c in 0..3 {
                    let a = ours.rgba[i * 4 + c] as f64;
                    let b = pair.camera_srgb[i * 3 + c] as f64;
                    sum += (a - b).abs();
                    n += 1;
                }
            }
            (sum, n)
        })
        .reduce(|| (0.0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    sum / count.max(1) as f64
}

// ---------------------------------------------------------------- fitting

/// Which slider, its bounds, and how coarsely to start moving it.
struct Axis {
    name: &'static str,
    get: fn(&DevelopParams) -> f32,
    set: fn(&mut DevelopParams, f32),
    min: f32,
    max: f32,
    step: f32,
}

macro_rules! axis {
    ($field:ident, $min:expr, $max:expr, $step:expr) => {
        Axis {
            name: stringify!($field),
            get: |p| p.$field,
            set: |p, v| p.$field = v,
            min: $min,
            max: $max,
            step: $step,
        }
    };
}

const ALL_AXES: [Axis; 8] = [
    axis!(exposure, -5.0, 5.0, 0.8),
    axis!(contrast, -100.0, 100.0, 32.0),
    axis!(highlights, -100.0, 100.0, 32.0),
    axis!(shadows, -100.0, 100.0, 32.0),
    axis!(whites, -100.0, 100.0, 32.0),
    axis!(blacks, -100.0, 100.0, 32.0),
    axis!(vibrance, -100.0, 100.0, 32.0),
    axis!(saturation, -100.0, 100.0, 32.0),
];

const EXPOSURE_ONLY: [Axis; 1] = [axis!(exposure, -5.0, 5.0, 0.8)];

/// Coordinate descent with a shrinking step. The parameters interact (contrast
/// moves the whites, whites move the mean) so one pass is not enough, but the
/// surface is smooth and this converges in a handful of them.
fn fit(pairs: &[Pair], start: DevelopParams, axes: &[Axis]) -> DevelopParams {
    let mut best = start;
    let mut best_err = error(pairs, &best);
    let mut scale = 1.0f32;

    for _pass in 0..9 {
        for axis in axes {
            let step = axis.step * scale;
            loop {
                let here = (axis.get)(&best);
                let mut improved = false;
                for candidate in [here - step, here + step] {
                    let candidate = candidate.clamp(axis.min, axis.max);
                    if candidate == here {
                        continue;
                    }
                    let mut trial = best;
                    (axis.set)(&mut trial, candidate);
                    let err = error(pairs, &trial);
                    // Strict improvement only, with no dead band: a weak axis
                    // like whites moves the error by a thousandth of a unit at
                    // a time, and a dead band would stop the descent on a
                    // ridge it could still walk down.
                    if err < best_err - 1e-7 {
                        best = trial;
                        best_err = err;
                        improved = true;
                        break;
                    }
                }
                if !improved {
                    break;
                }
            }
        }
        scale *= 0.5;
    }
    best
}

// ---------------------------------------------------------------- reporting

/// The gain between our decode and the camera's, per channel, measured in the
/// midtones where neither is clipping. A common factor is exposure; a spread
/// between the channels is white balance the sliders cannot reach.
fn midtone_gains(pair: &Pair) -> Option<[f32; 3]> {
    let mut ratios: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for i in interior(pair) {
        for (c, channel) in ratios.iter_mut().enumerate() {
            let ours = pair.scene.rgb[i * 3 + c];
            let theirs = pair.camera_linear[i * 3 + c];
            // Midtones only: below this the JPEG's black point dominates,
            // above it the camera's highlight roll-off does, and neither is a
            // gain. The median over what is left is robust to both.
            if (0.02..0.5).contains(&ours) && theirs > 0.002 {
                channel.push(theirs / ours);
            }
        }
    }
    if ratios.iter().any(|r| r.len() < 100) {
        return None;
    }
    Some([
        median(&mut ratios[0]),
        median(&mut ratios[1]),
        median(&mut ratios[2]),
    ])
}

fn report_channel_gains(pairs: &[Pair]) {
    let overall: Vec<[f32; 3]> = pairs.iter().filter_map(midtone_gains).collect();
    if overall.is_empty() {
        return;
    }
    let mut per_channel: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for g in &overall {
        for c in 0..3 {
            per_channel[c].push(g[c]);
        }
    }
    let m = [
        median(&mut per_channel[0]),
        median(&mut per_channel[1]),
        median(&mut per_channel[2]),
    ];
    println!(
        "midtone gain camera/ours   R {:.3}  G {:.3}  B {:.3}   → R/G {:.3}, B/G {:.3} ({:+.2} EV overall)",
        m[0],
        m[1],
        m[2],
        m[0] / m[1],
        m[2] / m[1],
        m[1].log2()
    );
    // A cast that is the same in every frame is a fixed difference in how the
    // two decoders read the sensor, and belongs in the preset. One that varies
    // from frame to frame is the camera deciding per shot, and cannot go in.
    let mut rg: Vec<f32> = overall.iter().map(|g| g[0] / g[1]).collect();
    let mut bg: Vec<f32> = overall.iter().map(|g| g[2] / g[1]).collect();
    println!(
        "   across frames: R/G {:.3}–{:.3}, B/G {:.3}–{:.3}   (a spread beyond ±2% is white \
         balance, which no tone slider can fix)\n",
        percentile(&mut rg, 0.1),
        percentile(&mut rg, 0.9),
        percentile(&mut bg, 0.1),
        percentile(&mut bg, 0.9)
    );
}

/// What a single fixed preset necessarily leaves on the table: the camera
/// decides per frame, so refitting each image says how much of the residual is
/// the preset's fault versus the camera's own variation.
fn report_per_image(pairs: &[Pair], preset: &DevelopParams) {
    let mut exposures = Vec::new();
    let mut with_exposure = Vec::new();
    let mut full = Vec::new();

    for pair in pairs {
        let one = std::slice::from_ref(pair);
        let tuned = fit(one, *preset, &EXPOSURE_ONLY);
        exposures.push(tuned.exposure - preset.exposure);
        with_exposure.push(error(one, &tuned));
        full.push(error(one, &fit(one, tuned, &ALL_AXES)));
    }

    let preset_err: Vec<f64> = pairs
        .iter()
        .map(|p| error(std::slice::from_ref(p), preset))
        .collect();
    let mut ranked: Vec<(&str, f64)> = pairs
        .iter()
        .zip(&preset_err)
        .map(|(p, e)| (p.name.as_str(), *e))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    println!("\nper image, on top of the preset:");
    println!(
        "  preset as-is        mean |Δ| {:.2}   worst: {}",
        mean(&preset_err),
        ranked
            .iter()
            .take(3)
            .map(|(n, e)| format!("{n} {e:.1}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "  + own exposure      mean |Δ| {:.2}   exposure spread {:+.2} … {:+.2} EV",
        mean(&with_exposure),
        min_f32(&exposures),
        max_f32(&exposures)
    );
    println!(
        "  + every slider      mean |Δ| {:.2}   (the floor: what this pipeline can express)",
        mean(&full)
    );
}

/// Printed from the axis list rather than field by field, so a slider added to
/// the search cannot be left out of the report.
fn print_params(label: &str, p: &DevelopParams) {
    let parts: Vec<String> = ALL_AXES
        .iter()
        .map(|a| {
            let v = (a.get)(p);
            if a.name == "exposure" {
                format!("{} {v:+.2} EV", a.name)
            } else {
                format!("{} {v:+.0}", a.name)
            }
        })
        .collect();
    println!("  {label}: {}", parts.join(", "));
}

fn median(values: &mut [f32]) -> f32 {
    percentile(values, 0.5)
}

fn percentile(values: &mut [f32], q: f32) -> f32 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let i = ((values.len() - 1) as f32 * q).round() as usize;
    values[i]
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn min_f32(values: &[f32]) -> f32 {
    values.iter().cloned().fold(f32::INFINITY, f32::min)
}

fn max_f32(values: &[f32]) -> f32 {
    values.iter().cloned().fold(f32::NEG_INFINITY, f32::max)
}
