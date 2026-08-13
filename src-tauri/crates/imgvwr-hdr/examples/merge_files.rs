//! Merge JPEG frames from the command line — the crate exercised against
//! real brackets, the way `match_camera` exercises the develop pipeline.
//!
//!     cargo run -p imgvwr-hdr --release --example merge_files -- out.jpg in1.jpg in2.jpg ...

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("first argument: the output path");
    let paths: Vec<String> = args.collect();
    assert!(paths.len() >= 2, "give at least two input frames");

    let started = std::time::Instant::now();
    let frames: Vec<image::RgbImage> = paths
        .iter()
        .map(|p| image::open(p).expect(p).into_rgb8())
        .collect();
    println!("decoded {} frames in {:.1?}", frames.len(), started.elapsed());

    let merging = std::time::Instant::now();
    let merged = match imgvwr_hdr::merge(&frames) {
        Ok(merged) => merged,
        Err(refusal) => {
            println!("refused: {refusal}");
            return;
        }
    };
    let motions: Vec<String> = merged
        .motions
        .iter()
        .map(|m| match m {
            Some(m) => format!("({:+.1}, {:+.1}, {:+.2}°)", m.tx, m.ty, m.degrees()),
            None => "left out".to_string(),
        })
        .collect();
    println!(
        "merged in {:.1?}; reference frame {}; motions [{}]; output {}×{}",
        merging.elapsed(),
        merged.reference,
        motions.join(", "),
        merged.image.width(),
        merged.image.height(),
    );

    merged.image.save(&out).expect("write output");
    println!("wrote {out}");
}
