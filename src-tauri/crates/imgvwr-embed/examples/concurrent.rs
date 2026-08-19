//! Hammers one loaded model from several threads — the shape of the Metal-residency crash
//! (SIGABRT in libmalloc, no Rust panic). Not a `#[test]`: needs a multi-gigabyte model and a GPU.
//! A clean run is not evidence the race is gone (with the lock removed it ran clean at 10×40);
//! it checks that the same input gives the same vector and that serialising has not deadlocked.

use std::sync::Arc;

fn main() {
    let image = std::env::args().nth(1).expect("usage: concurrent <image file>");
    let image = std::path::PathBuf::from(image);
    assert!(image.exists(), "no such image: {}", image.display());

    let cache = dirs_cache().join("models");
    let spec = imgvwr_embed::model_spec("siglip2-base").expect("model spec");
    assert!(
        imgvwr_embed::is_downloaded(spec, &cache),
        "download SigLIP 2 Base in the app first; this example never downloads"
    );

    eprintln!("loading…");
    let embedder = Arc::new(imgvwr_embed::Embedder::load(spec, &cache).expect("load"));

    // Thread 0 stands in for phrase ranking; the rest for the indexing pass.
    let rounds: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(12);
    let threads_n: usize = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(3);
    let mut threads = Vec::new();
    eprintln!("{threads_n} threads x {rounds} rounds");
    for id in 0..threads_n {
        let embedder = Arc::clone(&embedder);
        let image = image.clone();
        threads.push(std::thread::spawn(move || {
            let mut first: Option<Vec<f32>> = None;
            for round in 0..rounds {
                let v = if id == 0 {
                    embedder.embed_text("people dancing").expect("embed_text")
                } else {
                    embedder.embed_image_file(&image).expect("embed_image_file")
                };
                // The same input must give the same vector; a trampled device would not.
                match &first {
                    None => first = Some(v),
                    Some(known) => {
                        let drift: f32 = known
                            .iter()
                            .zip(&v)
                            .map(|(a, b)| (a - b).abs())
                            .fold(0.0, f32::max);
                        assert!(drift < 1e-4, "thread {id} round {round} drifted by {drift}");
                    }
                }
            }
            eprintln!("thread {id}: {rounds} passes, stable");
        }));
    }
    for t in threads {
        t.join().expect("a thread died");
    }
    println!("all threads finished without corrupting the device");
}

/// The app's cache root, so this reuses whatever the app already downloaded.
fn dirs_cache() -> std::path::PathBuf {
    let home = std::env::var("HOME").expect("HOME");
    std::path::PathBuf::from(home).join("Library/Caches/com.pmigdal.imgvwr")
}
