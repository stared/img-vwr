//! Measure a model's real load/embed timings on this machine:
//! cargo run --release -p imgvwr-embed --example bench -- <model-id> <models-dir> <image> [n]

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(id), Some(models_dir), Some(image)) = (args.get(1), args.get(2), args.get(3)) else {
        eprintln!("usage: bench <model-id> <models-dir> <image> [n]");
        std::process::exit(2);
    };
    let n: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10);

    let spec = imgvwr_embed::model_spec(id).expect("unknown model id");
    let t = Instant::now();
    let embedder = imgvwr_embed::Embedder::load(spec, std::path::Path::new(models_dir)).unwrap();
    println!("load: {:.1?}", t.elapsed());

    let image = std::path::Path::new(image);
    let t = Instant::now();
    let v = embedder.embed_image_file(image).unwrap();
    println!("first image (warm-up): {:.1?}  dim={}", t.elapsed(), v.len());

    let t = Instant::now();
    for _ in 0..n {
        embedder.embed_image_file(image).unwrap();
    }
    println!("per image: {:.1?} (over {n})", t.elapsed() / n);

    let t = Instant::now();
    embedder.embed_text("a photo of people dancing at a party").unwrap();
    println!("text query: {:.1?}", t.elapsed());
}
