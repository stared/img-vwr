//! Dump the embedded full-size JPEG out of a raw file, for verifying that
//! the exact-default path serves the camera's own rendering.
//!
//!     cargo run --release -p imgvwr-raw --example dump_embedded -- IN.NEF OUT.jpg

fn main() {
    let mut args = std::env::args().skip(1);
    let (input, output) = (args.next().expect("IN.NEF"), args.next().expect("OUT.jpg"));
    let bytes = imgvwr_raw::embedded_jpeg(std::path::Path::new(&input))
        .expect("no embedded JPEG found");
    std::fs::write(&output, &bytes).expect("write failed");
    println!("{} bytes -> {}", bytes.len(), output);
}
