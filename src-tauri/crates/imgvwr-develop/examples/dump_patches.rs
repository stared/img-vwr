//! Dumps 1:1 centre patches for texture fitting: our full looked render
//! next to the camera JPEG's matching crop (with a margin for alignment).
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example dump_patches -- <out-dir> <raw>...
//! ```
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

    let lines: Vec<String> = args[1..]
        .par_iter()
        .filter_map(|raw| match dump_one(Path::new(raw), &out_dir) {
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

fn dump_one(raw: &Path, out_dir: &Path) -> Result<String, String> {
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
    let region = Region {
        x: 0.5 - rw / 2.0,
        y: 0.5 - rh / 2.0,
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
    let crop = image::imageops::crop_imm(&img, (jw - side) / 2, (jh - side) / 2, side, side);
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
