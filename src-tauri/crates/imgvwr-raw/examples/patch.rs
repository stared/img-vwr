//! Renders a 1:1 centre patch through the shipped plugin, for eyeballing against the camera's JPEG.

use std::path::PathBuf;

use imgvwr_core::{linear_to_srgb, Region, RenderRequest, SceneFormat};

const PATCH: f32 = 768.0;

fn main() {
    let mut args = std::env::args().skip(1);
    let raw = PathBuf::from(args.next().expect("usage: patch <raw> <out.png>"));
    let out = PathBuf::from(args.next().expect("usage: patch <raw> <out.png>"));

    let scene = imgvwr_raw::CoreImageRawFormat::new()
        .open(&raw)
        .expect("open");
    let (w, h) = scene.native_size();
    let (rw, rh) = (PATCH / w as f32, PATCH / h as f32);
    let region = Region {
        x: 0.5 - rw / 2.0,
        y: 0.5 - rh / 2.0,
        width: rw,
        height: rh,
    };
    let linear = scene
        .render(RenderRequest {
            max_edge: PATCH as u32,
            white_balance: scene.as_shot(),
            region,
        })
        .expect("render");

    let mut img = image::RgbImage::new(linear.width, linear.height);
    for (i, px) in img.pixels_mut().enumerate() {
        for c in 0..3 {
            px[c] = (linear_to_srgb(linear.rgb[i * 3 + c].clamp(0.0, 1.0)) * 255.0).round() as u8;
        }
    }
    img.save(&out).expect("save");
    println!("wrote {} ({}x{})", out.display(), linear.width, linear.height);
}
