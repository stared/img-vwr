//! Five-landmark alignment onto the ArcFace template, the crop the identity model expects.

/// Normalized to the oriented bitmap, origin top-left.
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Landmarks, when found: left eye, right eye, nose, mouth corners — normalized to the image, origin top-left.
pub struct DetectedFace {
    pub rect: FaceBox,
    pub landmarks: Option<[[f32; 2]; 5]>,
}

/// insightface's canonical ArcFace template: where the five landmarks land in an aligned 112×112 crop.
const FACE_TEMPLATE: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

/// A 2D similarity transform y = A·x + t with A = [[a, -b], [b, a]].
pub(super) struct Similarity2D {
    a: f32,
    b: f32,
    tx: f32,
    ty: f32,
}

/// Mean landmark error (template px) above which the fit is a true profile squeezed onto a frontal template.
const MAX_ALIGN_RESIDUAL: f32 = 8.0;

/// Least-squares fit of detected landmarks (image px) onto the template; None when too poor to trust.
pub(super) fn align_transform(points: &[[f32; 2]; 5]) -> Option<Similarity2D> {
    let mean = |pts: &[[f32; 2]; 5]| {
        let (mut mx, mut my) = (0f32, 0f32);
        for p in pts {
            mx += p[0];
            my += p[1];
        }
        [mx / 5.0, my / 5.0]
    };
    let (ms, md) = (mean(points), mean(&FACE_TEMPLATE));
    let (mut sxx, mut num_a, mut num_b) = (0f32, 0f32, 0f32);
    for (s, d) in points.iter().zip(FACE_TEMPLATE.iter()) {
        let (xs, ys) = (s[0] - ms[0], s[1] - ms[1]);
        let (xd, yd) = (d[0] - md[0], d[1] - md[1]);
        sxx += xs * xs + ys * ys;
        num_a += xs * xd + ys * yd;
        num_b += xs * yd - ys * xd;
    }
    if sxx < 1e-6 {
        return None;
    }
    let (a, b) = (num_a / sxx, num_b / sxx);
    let tx = md[0] - (a * ms[0] - b * ms[1]);
    let ty = md[1] - (b * ms[0] + a * ms[1]);
    let t = Similarity2D { a, b, tx, ty };
    // Judge the fit where it will be used: in template pixels.
    let mut residual = 0f32;
    for (s, d) in points.iter().zip(FACE_TEMPLATE.iter()) {
        let px = t.a * s[0] - t.b * s[1] + t.tx;
        let py = t.b * s[0] + t.a * s[1] + t.ty;
        residual += ((px - d[0]).powi(2) + (py - d[1]).powi(2)).sqrt();
    }
    if residual / 5.0 > MAX_ALIGN_RESIDUAL {
        return None;
    }
    Some(t)
}

pub(super) fn warp_aligned(img: &image::DynamicImage, t: &Similarity2D) -> image::RgbImage {
    let src = img.to_rgb8();
    let (w, h) = (src.width() as i64, src.height() as i64);
    // Inverse of y = A·x + t for a similarity: x = Aᵀ·(y − t) / |A|².
    let det = t.a * t.a + t.b * t.b;
    let (ia, ib) = (t.a / det, -t.b / det);
    let mut out = image::RgbImage::new(112, 112);
    for v in 0..112u32 {
        for u in 0..112u32 {
            let (dx, dy) = (u as f32 - t.tx, v as f32 - t.ty);
            let sx = ia * dx - ib * dy;
            let sy = ib * dx + ia * dy;
            let (x0, y0) = (sx.floor() as i64, sy.floor() as i64);
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            let sample = |x: i64, y: i64| -> [f32; 3] {
                let (cx, cy) = (x.clamp(0, w - 1) as u32, y.clamp(0, h - 1) as u32);
                let p = src.get_pixel(cx, cy);
                [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]
            };
            let (p00, p10, p01, p11) =
                (sample(x0, y0), sample(x0 + 1, y0), sample(x0, y0 + 1), sample(x0 + 1, y0 + 1));
            let mut px = [0u8; 3];
            for c in 0..3 {
                let top = p00[c] * (1.0 - fx) + p10[c] * fx;
                let bottom = p01[c] * (1.0 - fx) + p11[c] * fx;
                px[c] = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
            }
            out.put_pixel(u, v, image::Rgb(px));
        }
    }
    out
}
