//! Dumps matched raw/JPEG pairs onto a shared small grid for offline fitting.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example dump_pairs -- <out-dir> <dir>...
//! ```
//!
//! For every raw file with a camera JPEG beside it, writes into `<out-dir>`:
//!
//! - `<stem>_scene.f32` — the plugin's neutral scene-linear render at the
//!   camera's own white balance (RGB f32, native endianness, row-major)
//! - `<stem>_cam.f32`   — the camera JPEG box-averaged onto the same grid in
//!   linear light (RGB f32)
//! - a line in `manifest.jsonl` with the grid size and the exposure facts
//!
//! Small on purpose (`GRID_EDGE`): the camera corrects lens geometry where we
//! do not, and a coarse grid turns that misalignment into noise instead of
//! structure. Existing dumps are skipped, so a second run only fills gaps.

use std::io::Write;
use std::path::{Path, PathBuf};

use imgvwr_core::{srgb_to_linear, Region, RenderRequest, SceneFormat, WhiteBalance};
use imgvwr_raw::CoreImageRawFormat;
use rayon::prelude::*;

const GRID_EDGE: u32 = 512;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: dump_pairs <out-dir> <dir-or-raw-file>...");
        std::process::exit(2);
    }
    let out_dir = PathBuf::from(&args[0]);
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let raws = collect_raws(&args[1..]);
    println!("{} raw files", raws.len());

    let lines: Vec<String> = raws
        .par_iter()
        .filter_map(|raw| match dump_pair(raw, &out_dir) {
            Ok(Some(line)) => Some(line),
            Ok(None) => None,
            Err(e) => {
                eprintln!("skipped {}: {e}", raw.display());
                None
            }
        })
        .collect();

    let manifest = out_dir.join("manifest.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&manifest)
        .expect("open manifest");
    for line in &lines {
        writeln!(file, "{line}").expect("write manifest");
    }
    println!("dumped {} pairs → {}", lines.len(), out_dir.display());
}

fn dump_pair(raw: &Path, out_dir: &Path) -> Result<Option<String>, String> {
    let jpeg = sibling_jpeg(raw).ok_or("no sibling JPEG")?;
    let stem = raw
        .file_stem()
        .ok_or("no stem")?
        .to_string_lossy()
        .into_owned();
    let folder = raw
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tag = format!("{}_{stem}", folder.replace(' ', "-"));

    let scene_path = out_dir.join(format!("{tag}_scene.f32"));
    let cam_path = out_dir.join(format!("{tag}_cam.f32"));
    if scene_path.is_file() && cam_path.is_file() {
        return Ok(None);
    }

    let opened = CoreImageRawFormat::new()
        .open(raw)
        .map_err(|e| e.to_string())?;
    let as_shot = opened.as_shot();
    let scene = opened
        .render(RenderRequest {
            max_edge: GRID_EDGE,
            white_balance: as_shot,
            region: Region::FULL,
        })
        .map_err(|e| e.to_string())?;

    let (w, h) = (scene.width as usize, scene.height as usize);
    let camera = jpeg_on_grid(&jpeg, w, h)?;

    write_f32(&scene_path, &scene.rgb)?;
    write_f32(&cam_path, &camera)?;

    let meta = imgvwr_core::read_meta(raw).ok();
    let exif = meta.and_then(|m| m.exif);
    let (iso, exposure_time, f_number) = exif
        .map(|e| (e.iso, e.exposure_time, e.f_number))
        .unwrap_or((None, None, None));

    Ok(Some(format!(
        "{{\"tag\":\"{tag}\",\"folder\":\"{folder}\",\"w\":{w},\"h\":{h},\
         \"temp\":{},\"tint\":{},\"iso\":{},\"exposure_time\":{},\"f_number\":{}}}",
        as_shot.temperature,
        as_shot.tint,
        iso.map(|v| v.to_string()).unwrap_or("null".into()),
        exposure_time.map(|v| v.to_string()).unwrap_or("null".into()),
        f_number.map(|v| v.to_string()).unwrap_or("null".into()),
    )))
}

fn write_f32(path: &Path, data: &[f32]) -> Result<(), String> {
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 4) };
    std::fs::write(path, bytes).map_err(|e| e.to_string())
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

fn sibling_jpeg(raw: &Path) -> Option<PathBuf> {
    for ext in ["JPG", "jpg", "JPEG", "jpeg"] {
        let candidate = raw.with_extension(ext);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The camera JPEG, oriented like the raw render and box-averaged onto its
/// grid in linear light (averaging sRGB values darkens edges).
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

// Silence the unused-item lint for WhiteBalance in signatures above.
#[allow(dead_code)]
fn _unused(_: WhiteBalance) {}
