//! End-to-end check of the develop pipeline against a real file, and the
//! place to measure whether interaction stays interactive.
//!
//! ```sh
//! cargo run --release -p imgvwr-develop --example develop -- photo.NEF /tmp/out
//! ```
//!
//! Writes `<out>-neutral.png`, `<out>-edited.png` and `<out>-focus.png`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use imgvwr_core::{ImageCrateFormat, Region, SceneRegistry};
use imgvwr_develop::{render, DevelopParams, DevelopSettings, Overlay};

const PREVIEW_EDGE: u32 = 2000;

fn main() {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("usage: develop <image> [out-prefix]"));
    let out_prefix = args.next().unwrap_or_else(|| "/tmp/develop".into());

    let registry = SceneRegistry::new(vec![
        Arc::from(imgvwr_raw::raw_format()),
        Arc::new(ImageCrateFormat::new()),
    ]);

    let t = Instant::now();
    let scene = registry.open(&input).expect("open failed");
    println!("open            : {:?}", t.elapsed());
    println!("  native size   : {:?}", scene.native_size());
    println!("  as shot       : {:?}", scene.as_shot());

    let neutral = DevelopSettings::neutral(scene.as_shot());

    let t = Instant::now();
    let out = render(scene.as_ref(), &neutral, PREVIEW_EDGE, Overlay::None, Region::FULL).expect("render");
    println!("neutral preview : {:?} ({}x{})", t.elapsed(), out.image.width, out.image.height);
    println!(
        "  clipped       : {} shadow / {} highlight px",
        out.histogram.clipped_shadows, out.histogram.clipped_highlights
    );
    save(&out.image, &format!("{out_prefix}-neutral.png"));

    // What a slider drag costs: the scene stays open, only settings change.
    let edited = DevelopSettings {
        white_balance: imgvwr_core::WhiteBalance {
            temperature: scene.as_shot().temperature + 1200.0,
            tint: scene.as_shot().tint,
        },
        params: DevelopParams {
            exposure: 0.75,
            contrast: 25.0,
            highlights: -40.0,
            shadows: 35.0,
            whites: 10.0,
            blacks: -10.0,
            rolloff: 60.0,
            vibrance: 30.0,
            saturation: 0.0,
        },
        basis: imgvwr_develop::presets::NONE.to_owned(),
        crop: imgvwr_develop::Crop::FULL,
    };
    let mut worst = std::time::Duration::ZERO;
    for _ in 0..5 {
        let t = Instant::now();
        let out = render(scene.as_ref(), &edited, PREVIEW_EDGE, Overlay::None, Region::FULL).expect("render");
        worst = worst.max(t.elapsed());
        std::hint::black_box(&out.image.rgba[0]);
    }
    println!("edited preview  : {worst:?} (worst of 5 — this is the slider-drag cost)");
    let out = render(scene.as_ref(), &edited, PREVIEW_EDGE, Overlay::None, Region::FULL).expect("render");
    save(&out.image, &format!("{out_prefix}-edited.png"));

    let t = Instant::now();
    let focus = render(scene.as_ref(), &neutral, PREVIEW_EDGE, Overlay::Sharpness, Region::FULL).expect("render");
    println!("focus overlay   : {:?}", t.elapsed());
    save(&focus.image, &format!("{out_prefix}-focus.png"));

    let (nw, nh) = scene.native_size();
    let t = Instant::now();
    let full = render(scene.as_ref(), &edited, nw.max(nh), Overlay::None, Region::FULL).expect("render");
    println!(
        "full export     : {:?} ({}x{})",
        t.elapsed(),
        full.image.width,
        full.image.height
    );
}

fn save(img: &imgvwr_core::DecodedImage, path: &str) {
    image::RgbaImage::from_raw(img.width, img.height, img.rgba.clone())
        .expect("buffer size")
        .save(Path::new(path))
        .expect("write");
    println!("  wrote {path}");
}
