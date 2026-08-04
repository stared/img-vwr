//! Hammer one loaded model from several threads at once.
//!
//! This is the shape of the crash that took the app down: a folder indexing
//! in the background (a stream of `embed_image_file`) while the foreground
//! ranks a phrase (`embed_text`). candle's Metal device mutates a residency
//! set on every tensor allocation and Metal does not guard it, so the two
//! together corrupted the allocator and the process died in libmalloc with
//! "pointer being freed was not allocated" — SIGABRT, no Rust panic message,
//! nothing in the app's own logs.
//!
//! It cannot be a `#[test]`: it needs a multi-gigabyte model on disk and a
//! real GPU. So it lives here, to be run by hand against a machine that has
//! both.
//!
//!     cargo run --release -p imgvwr-embed --example concurrent -- <image.jpg>
//!
//! Honest about what it proves. The abort is a data race and races are not
//! reproducible on demand: with the lock removed this ran clean at ten
//! threads by forty rounds, in both profiles, and the crash it is modelled
//! on happened once in ordinary use. So a clean run here is not evidence the
//! bug is gone. What it does check is the invariant a trampled device would
//! break — that the same input gives the same vector no matter who else is
//! computing — and that serialising inference has not deadlocked or slowed
//! the thing to a halt.

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

    // Two writers of the same kind the app runs: one standing in for the
    // indexing pass, one for the ranking the user keeps re-triggering.
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
                // The same input must give the same vector every time; a
                // device being trampled by another thread would not.
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
