//! Dumps Vision face boxes for every JPEG given, one JSON line per file —
//! offline input for fitting subject-aware camera-look features.
//!
//! ```sh
//! cargo run --release --bin dump_faces -- <out.jsonl> <jpeg>...
//! ```
//!
//! Boxes are normalized to the ORIENTED image, origin top-left — the same
//! frame the pair dumps use.

use std::io::Write;

use objc2::rc::Retained;
use objc2::AnyThread as _;
use objc2_foundation::{NSArray, NSData, NSDictionary};
use objc2_vision::{VNDetectFaceRectanglesRequest, VNImageRequestHandler, VNRequest};

const DETECT_EDGE: u32 = 1024;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: dump_faces <out.jsonl> <jpeg>...");
        std::process::exit(2);
    }
    let mut out = std::fs::File::create(&args[0]).expect("create out");
    for path in &args[1..] {
        match faces_of(path) {
            Ok(boxes) => {
                let list: Vec<String> = boxes
                    .iter()
                    .map(|b| format!("[{:.5},{:.5},{:.5},{:.5}]", b.0, b.1, b.2, b.3))
                    .collect();
                writeln!(out, "{{\"path\":\"{path}\",\"boxes\":[{}]}}", list.join(","))
                    .expect("write");
            }
            Err(e) => eprintln!("skipped {path}: {e}"),
        }
    }
}

fn faces_of(path: &str) -> Result<Vec<(f32, f32, f32, f32)>, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let orientation = imgvwr_core::read_meta(std::path::Path::new(path))
        .ok()
        .and_then(|m| m.exif)
        .map(|e| e.orientation)
        .unwrap_or(1);
    let img = match orientation {
        6 => image::DynamicImage::ImageRgb8(image::imageops::rotate90(&img.to_rgb8())),
        8 => image::DynamicImage::ImageRgb8(image::imageops::rotate270(&img.to_rgb8())),
        3 => image::DynamicImage::ImageRgb8(image::imageops::rotate180(&img.to_rgb8())),
        _ => img,
    };
    let img = img.thumbnail(DETECT_EDGE, DETECT_EDGE);
    let mut jpeg = Vec::new();
    img.to_rgb8()
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|e| e.to_string())?;

    // SAFETY: plain Objective-C message sends on objects we own; the request
    // handler runs synchronously on this thread. Mirrors services::faces.
    unsafe {
        let data = NSData::with_bytes(&jpeg);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNDetectFaceRectanglesRequest::new();
        let as_request: Retained<VNRequest> =
            Retained::into_super(Retained::into_super(request.clone()));
        let requests = NSArray::from_retained_slice(&[as_request]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| e.to_string())?;
        let Some(results) = request.results() else {
            return Ok(Vec::new());
        };
        Ok(results
            .iter()
            .map(|obs| {
                let b = obs.boundingBox();
                (
                    b.origin.x as f32,
                    // Vision's origin is bottom-left; ours top-left.
                    1.0 - (b.origin.y + b.size.height) as f32,
                    b.size.width as f32,
                    b.size.height as f32,
                )
            })
            .collect())
    }
}
