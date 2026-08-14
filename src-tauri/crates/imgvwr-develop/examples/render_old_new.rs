//! Renders one raw two ways for a before/after: the old slider preset and
//! the fitted camera look. `<out>-old.png`, `<out>-new.png`.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example render_old_new -- <raw> <out-prefix> [edge]
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use imgvwr_core::{ImageCrateFormat, Region, SceneRegistry};
use imgvwr_develop::{DevelopParams, DevelopSettings, Overlay};

fn main() {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("usage: render_old_new <raw> <out-prefix>"));
    let prefix = args.next().expect("out prefix");
    let edge: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1200);

    let registry = SceneRegistry::new(vec![
        Arc::from(imgvwr_raw::raw_format()),
        Arc::new(ImageCrateFormat::new()),
    ]);
    let scene = registry.open(&input).expect("open");

    // The preset that shipped before the camera look, through the same
    // pipeline it ran in (no look): exactly what the app used to show.
    let old = DevelopSettings {
        params: DevelopParams {
            exposure: 0.80,
            contrast: 36.0,
            highlights: -22.0,
            shadows: -33.0,
            whites: 68.0,
            blacks: 0.0,
            rolloff: 83.0,
            vibrance: 32.0,
            saturation: 2.0,
        },
        ..DevelopSettings::neutral(scene.as_shot())
    };
    let out = imgvwr_develop::render(scene.as_ref(), &old, edge, Overlay::None, Region::FULL)
        .expect("render old");
    save(&out.image, &format!("{prefix}-old.png"));

    let opening = imgvwr_develop::opening_settings(scene.as_shot(), scene.rendering());
    let small = imgvwr_develop::render_linear(scene.as_ref(), &opening, 384, Region::FULL)
        .expect("measure");
    let iso = imgvwr_core::read_meta(&input)
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso);
    let tuning = imgvwr_develop::LookTuning::measure(&small, iso, scene.as_shot(), &imgvwr_core::read_camera_decisions(&input));
    let out = imgvwr_develop::render_looked(
        scene.as_ref(), &opening, edge, Overlay::None, Region::FULL, Some(&tuning),
    )
    .expect("render new");
    save(&out.image, &format!("{prefix}-new.png"));
}

fn save(img: &imgvwr_core::DecodedImage, path: &str) {
    image::RgbaImage::from_raw(img.width, img.height, img.rgba.clone())
        .expect("buffer")
        .save(path)
        .expect("save");
    println!("wrote {path}");
}
