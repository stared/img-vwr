//! Histogram digest of a finished JPEG passed through the identity develop —
//! the reference the exact-default path is checked against in the running app.
//!
//!     cargo run --release -p imgvwr-develop --example histo_digest -- FILE.JPG

fn digest(h: &[u32]) -> u64 {
    h.iter()
        .enumerate()
        .fold(0u64, |a, (i, &v)| (a + v as u64 * (i as u64 + 1)) % 4294967291)
}

fn main() {
    let path = std::env::args().nth(1).expect("FILE.JPG");
    let img = image::open(&path).expect("decode").to_rgba8();
    let scene = imgvwr_core::image_scene::scene_from_rgba(img);
    let settings = imgvwr_develop::opening_settings(
        imgvwr_core::WhiteBalance::D65,
        imgvwr_core::Rendering::AlreadyRendered,
    );
    let developed = imgvwr_develop::render_looked(
        scene.as_ref(),
        &settings,
        8000,
        imgvwr_develop::Overlay::None,
        imgvwr_core::Region::FULL,
        None,
    )
    .expect("render");
    let h = &developed.histogram;
    println!(
        "w {} h {} luma {} red {} green {} blue {} cs {} ch {}",
        developed.image.width,
        developed.image.height,
        digest(&h.luma),
        digest(&h.red),
        digest(&h.green),
        digest(&h.blue),
        h.clipped_shadows,
        h.clipped_highlights
    );
}
