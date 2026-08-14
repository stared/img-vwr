//! Dumps 1:1 centre patches for texture fitting: our full looked render
//! next to the camera JPEG's matching crop (with a margin for alignment).
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example dump_patches -- <out-dir> [--at cx,cy] <raw>...
//! ```
//!
//! `--at` moves the patch centre (normalized coordinates; default 0.5,0.5)
//! — corner patches are how lens-geometry agreement gets measured.
//!
//! Writes `<tag>_ours.png` (768² through decode + camera look, default
//! params) and `<tag>_cam.png` (the JPEG's centre 832² in its native
//! pixels — the extra 64 px absorb the raw-active-area offset during
//! alignment), plus `patches.jsonl` with ISO per tag.

use std::io::Write;
use std::path::{Path, PathBuf};

use imgvwr_core::{Region, SceneFormat};
use imgvwr_develop::{DevelopParams, LookTuning, Overlay};
use imgvwr_raw::CoreImageRawFormat;
use rayon::prelude::*;

const PATCH: u32 = 768;
const MARGIN: u32 = 32;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: dump_patches <out-dir> <raw>...");
        std::process::exit(2);
    }
    let out_dir = PathBuf::from(&args[0]);
    std::fs::create_dir_all(&out_dir).expect("create out dir");
    let (centre, rest) = if args.len() > 2 && args[1] == "--at" {
        let mut it = args[2].split(',').map(|v| v.parse::<f32>().unwrap_or(0.5));
        ((it.next().unwrap_or(0.5), it.next().unwrap_or(0.5)), &args[3..])
    } else {
        ((0.5, 0.5), &args[1..])
    };

    let lines: Vec<String> = rest
        .par_iter()
        .filter_map(|raw| match dump_one(Path::new(raw), &out_dir, centre) {
            Ok(line) => Some(line),
            Err(e) => {
                eprintln!("skipped {raw}: {e}");
                None
            }
        })
        .collect();
    let mut file = std::fs::File::create(out_dir.join("patches.jsonl")).expect("manifest");
    for line in &lines {
        writeln!(file, "{line}").expect("write");
    }
    println!("dumped {} patch pairs", lines.len());
}

fn dump_one(raw: &Path, out_dir: &Path, centre: (f32, f32)) -> Result<String, String> {
    let jpeg = sibling_jpeg(raw).ok_or("no sibling JPEG")?;
    let stem = raw.file_stem().ok_or("no stem")?.to_string_lossy().into_owned();
    let folder = raw
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tag = format!("{}_{stem}", folder.replace(' ', "-"));

    let scene = CoreImageRawFormat::new().open(raw).map_err(|e| e.to_string())?;
    let opening = imgvwr_develop::opening_settings(scene.as_shot(), scene.rendering());
    let small = imgvwr_develop::render_linear(scene.as_ref(), &opening, 384, Region::FULL)
        .map_err(|e| e.to_string())?;
    let iso = imgvwr_core::read_meta(raw)
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso);
    let tuning = LookTuning::measure(
        &small,
        iso,
        scene.as_shot(),
        &imgvwr_core::read_camera_decisions(raw),
    );

    let (w, h) = scene.native_size();
    let (rw, rh) = (PATCH as f32 / w as f32, PATCH as f32 / h as f32);
    let (cx, cy) = centre;
    let region = Region {
        x: (cx - rw / 2.0).clamp(0.0, 1.0 - rw),
        y: (cy - rh / 2.0).clamp(0.0, 1.0 - rh),
        width: rw,
        height: rh,
    };
    let settings = imgvwr_develop::DevelopSettings {
        params: DevelopParams::default(),
        ..opening
    };
    let out = imgvwr_develop::render_looked(scene.as_ref(), &settings, PATCH, Overlay::None, region, Some(&tuning))
        .map_err(|e| e.to_string())?;
    image::RgbaImage::from_raw(out.image.width, out.image.height, out.image.rgba.clone())
        .ok_or("buffer")?
        .save(out_dir.join(format!("{tag}_ours.png")))
        .map_err(|e| e.to_string())?;

    // The camera's own pixels around the same centre, orientation applied.
    let img = image::ImageReader::open(&jpeg)
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .to_rgb8();
    let orientation = imgvwr_core::read_meta(&jpeg)
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
    let side = PATCH + 2 * MARGIN;
    let (jw, jh) = (img.width(), img.height());
    if jw < side || jh < side {
        return Err("JPEG smaller than patch".into());
    }
    let jx = ((cx * jw as f32) as u32).saturating_sub(side / 2).min(jw - side);
    let jy = ((cy * jh as f32) as u32).saturating_sub(side / 2).min(jh - side);
    let crop = image::imageops::crop_imm(&img, jx, jy, side, side);
    crop.to_image()
        .save(out_dir.join(format!("{tag}_cam.png")))
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "{{\"tag\":\"{tag}\",\"iso\":{}}}",
        iso.map(|v| v.to_string()).unwrap_or("null".into())
    ))
}

fn sibling_jpeg(raw: &Path) -> Option<PathBuf> {
    for ext in ["JPG", "jpg", "JPEG", "jpeg"] {
        let p = raw.with_extension(ext);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}
