//! Measures how well the sliders recover clipped regions under the camera
//! look: renders a raw at several settings and reports detail statistics
//! over the regions that are blown (or crushed) in the default render.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example recovery -- <raw> [out-prefix]
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{ImageCrateFormat, Region, SceneRegistry};
use imgvwr_develop::{DevelopParams, DevelopSettings, LookTuning, Overlay};

const EDGE: u32 = 1600;

fn main() {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("usage: recovery <raw> [out-prefix]"));
    let prefix = args.next().unwrap_or_else(|| "/tmp/recovery".into());

    let registry = SceneRegistry::new(vec![
        Arc::from(imgvwr_raw::raw_format()),
        Arc::new(ImageCrateFormat::new()),
    ]);
    let scene = registry.open(&input).expect("open");
    let opening = imgvwr_develop::opening_settings(scene.as_shot(), scene.rendering());
    let small = imgvwr_develop::render_linear(scene.as_ref(), &opening, 384, Region::FULL)
        .expect("measure");
    let iso = imgvwr_core::read_meta(&input)
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso);
    let tuning = LookTuning::measure(&small, iso, scene.as_shot(), &imgvwr_core::read_camera_decisions(&input));

    let variants: Vec<(&str, DevelopParams)> = vec![
        ("default", DevelopParams::default()),
        ("hl-100", DevelopParams { highlights: -100.0, ..Default::default() }),
        ("exp-1", DevelopParams { exposure: -1.0, ..Default::default() }),
        ("exp-2", DevelopParams { exposure: -2.0, ..Default::default() }),
        ("hl-100exp-1", DevelopParams { highlights: -100.0, exposure: -1.0, ..Default::default() }),
        ("sh+100", DevelopParams { shadows: 100.0, ..Default::default() }),
        ("sh+100exp+1", DevelopParams { shadows: 100.0, exposure: 1.0, ..Default::default() }),
    ];

    let mut renders = Vec::new();
    for (name, params) in &variants {
        let settings = DevelopSettings { params: params.clone(), ..opening.clone() };
        let out = imgvwr_develop::render_looked(
            scene.as_ref(), &settings, EDGE, Overlay::None, Region::FULL, Some(&tuning),
        )
        .expect("render");
        let path = format!("{prefix}-{name}.png");
        image::RgbaImage::from_raw(out.image.width, out.image.height, out.image.rgba.clone())
            .expect("buffer")
            .save(&path)
            .expect("save");
        renders.push((name.to_string(), out.image));
    }

    // regions defined on the default render's luma
    let base = &renders[0].1;
    let luma8 = |px: &[u8]| {
        0.2126 * px[0] as f32 + 0.7152 * px[1] as f32 + 0.0722 * px[2] as f32
    };
    let n = (base.rgba.len() / 4) as usize;
    let blown: Vec<usize> = (0..n)
        .filter(|i| luma8(&base.rgba[i * 4..i * 4 + 3]) >= 250.0)
        .collect();
    let crushed: Vec<usize> = (0..n)
        .filter(|i| luma8(&base.rgba[i * 4..i * 4 + 3]) <= 6.0)
        .collect();
    println!(
        "default render: {:.2}% blown (>=250), {:.2}% crushed (<=6)",
        100.0 * blown.len() as f32 / n as f32,
        100.0 * crushed.len() as f32 / n as f32
    );

    let stats = |img: &imgvwr_core::DecodedImage, region: &[usize]| -> (f32, f32, f32) {
        if region.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        let ys: Vec<f32> = region.iter().map(|&i| luma8(&img.rgba[i * 4..i * 4 + 3])).collect();
        let mean = ys.iter().sum::<f32>() / ys.len() as f32;
        let var = ys.iter().map(|y| (y - mean).powi(2)).sum::<f32>() / ys.len() as f32;
        let still = ys.iter().filter(|&&y| y >= 250.0).count() as f32 / ys.len() as f32;
        (mean, var.sqrt(), still)
    };
    println!("\nover the blown region:");
    println!("{:<14} {:>8} {:>8} {:>10}", "variant", "mean", "std", "still>=250");
    for (name, img) in &renders {
        let (m, s, still) = stats(img, &blown);
        println!("{name:<14} {m:>8.1} {s:>8.2} {:>9.1}%", still * 100.0);
    }
    println!("\nover the crushed region (std = recovered detail):");
    println!("{:<14} {:>8} {:>8}", "variant", "mean", "std");
    for (name, img) in &renders {
        let (m, s, _) = stats(img, &crushed);
        println!("{name:<14} {m:>8.1} {s:>8.2}");
    }
}
