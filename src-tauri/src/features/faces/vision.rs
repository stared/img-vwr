use objc2::rc::Retained;
use objc2::AnyThread as _;
use objc2_core_foundation::CFData;
use objc2_core_graphics::{
    CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage, CGImageAlphaInfo,
};
use objc2_foundation::{NSArray, NSDictionary};
use objc2_vision::{
    VNDetectFaceLandmarksRequest, VNFaceLandmarkRegion2D, VNImageRequestHandler, VNRequest,
};

use super::{DetectedFace, FaceBox};

/// Vision gets the already-oriented pixels, so boxes and landmarks come back in the crops' own geometry.
pub fn detect_faces(img: &image::DynamicImage) -> Result<Vec<DetectedFace>, String> {
    let rgba = img.to_rgba8();
    // Index workers are plain threads with no pool of their own; Vision's autoreleased objects would pile up.
    objc2::rc::autoreleasepool(|_| detect_rgba(&rgba))
}

/// Pixels go in as a CGImage: a JPEG round-trip per photo was the slowest step of indexing.
fn detect_rgba(rgba: &image::RgbaImage) -> Result<Vec<DetectedFace>, String> {
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    // SAFETY: CFData copies the bytes; the CGImage owns its provider; the handler runs synchronously on this thread.
    unsafe {
        let data = CFData::new(None, rgba.as_raw().as_ptr(), rgba.as_raw().len() as isize)
            .ok_or("CFData allocation failed")?;
        let provider = CGDataProvider::with_cf_data(Some(&data)).ok_or("no data provider")?;
        let space = CGColorSpace::new_device_rgb().ok_or("no colour space")?;
        let image = CGImage::new(
            w,
            h,
            8,
            32,
            w * 4,
            Some(&space),
            CGBitmapInfo(CGImageAlphaInfo::NoneSkipLast.0),
            Some(&provider),
            std::ptr::null(),
            false,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
        .ok_or("CGImage creation failed")?;
        let handler = VNImageRequestHandler::initWithCGImage_options(
            VNImageRequestHandler::alloc(),
            &image,
            &NSDictionary::new(),
        );
        let request = VNDetectFaceLandmarksRequest::new();
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
                let rect = FaceBox {
                    x: b.origin.x as f32,
                    // Vision's origin is bottom-left; ours is top-left.
                    y: 1.0 - (b.origin.y + b.size.height) as f32,
                    width: b.size.width as f32,
                    height: b.size.height as f32,
                };
                // Region points are normalized to the face box, origin bottom-left; map to top-left image coordinates.
                let to_image = |p: [f32; 2]| -> [f32; 2] {
                    [
                        b.origin.x as f32 + p[0] * b.size.width as f32,
                        1.0 - (b.origin.y as f32 + p[1] * b.size.height as f32),
                    ]
                };
                let landmarks = obs.landmarks().and_then(|lm| {
                    let centroid = |r: Option<Retained<VNFaceLandmarkRegion2D>>| {
                        let r = r?;
                        let n = r.pointCount();
                        if n == 0 {
                            return None;
                        }
                        let pts = r.normalizedPoints();
                        let mut acc = [0f32; 2];
                        for k in 0..n {
                            let p = *pts.add(k);
                            acc[0] += p.x as f32;
                            acc[1] += p.y as f32;
                        }
                        Some([acc[0] / n as f32, acc[1] / n as f32])
                    };
                    let corner = |r: Option<Retained<VNFaceLandmarkRegion2D>>,
                                  left: bool| {
                        let r = r?;
                        let n = r.pointCount();
                        if n == 0 {
                            return None;
                        }
                        let pts = r.normalizedPoints();
                        let mut best: Option<[f32; 2]> = None;
                        for k in 0..n {
                            let p = *pts.add(k);
                            let candidate = [p.x as f32, p.y as f32];
                            let better = match best {
                                None => true,
                                Some(cur) => {
                                    if left {
                                        candidate[0] < cur[0]
                                    } else {
                                        candidate[0] > cur[0]
                                    }
                                }
                            };
                            if better {
                                best = Some(candidate);
                            }
                        }
                        best
                    };
                    let left_eye = centroid(lm.leftEye())?;
                    let right_eye = centroid(lm.rightEye())?;
                    let nose = centroid(lm.nose())?;
                    let mouth_left = corner(lm.outerLips(), true)?;
                    let mouth_right = corner(lm.outerLips(), false)?;
                    Some([
                        to_image(left_eye),
                        to_image(right_eye),
                        to_image(nose),
                        to_image(mouth_left),
                        to_image(mouth_right),
                    ])
                });
                DetectedFace { rect, landmarks }
            })
            .collect())
    }
}
