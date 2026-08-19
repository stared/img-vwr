//! Guided-filter NR (He et al., grey guide), matching the camera's high-ISO smoothing where
//! CIRAW's luminance-NR knob loses more edge than it removes noise (measured on aligned 1:1
//! patches, tools/camera-look). Runs after the look, only at 1:1-ish scale — previews average the noise away in the downsample.

use rayon::prelude::*;

/// 0..1 per axis; zero skips the pass, fractional strengths blend original and filtered.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NrStrength {
    pub chroma: f32,
    pub luma: f32,
    /// Base-ISO unsharp: the camera draws 1.27× our edge energy and CIRAW's sharpener maxes out below it.
    pub sharpen: f32,
}

impl NrStrength {
    pub const NONE: NrStrength = NrStrength {
        chroma: 0.0,
        luma: 0.0,
        sharpen: 0.0,
    };

    pub fn active(&self) -> bool {
        self.chroma > 0.0 || self.luma > 0.0 || self.sharpen > 0.0
    }
}

/// Fitted on 1:1 patches; radii scale with the render so the filter covers the same subject area at any zoom.
const CHROMA_RADIUS: f32 = 8.0;
const CHROMA_EPS: f32 = 0.004;
const LUMA_RADIUS: f32 = 4.0;
const LUMA_EPS: f32 = 0.001;
/// σ≈2 gaussian was fitted; a box of this radius has the same variance.
const SHARPEN_RADIUS: f32 = 3.0;
const SHARPEN_AMOUNT: f32 = 0.5;

/// In place on display-linear RGB; `scale` is rendered pixels per native pixel (1.0 at 1:1).
/// Filtering runs gamma-encoded — the strengths were fitted there; in linear light the same `eps` flattens shadows to mush.
pub fn apply(rgb: &mut [f32], w: usize, h: usize, s: NrStrength, scale: f32) {
    if w < 8 || h < 8 {
        return;
    }
    rgb.par_iter_mut().for_each(|v| *v = srgb_encode(*v));
    apply_encoded(rgb, w, h, s, scale);
    rgb.par_iter_mut().for_each(|v| *v = srgb_decode(*v));
}

fn srgb_encode(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_decode(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn apply_encoded(rgb: &mut [f32], w: usize, h: usize, s: NrStrength, scale: f32) {
    let y: Vec<f32> = rgb
        .par_chunks_exact(3)
        .map(|p| crate::pipeline::luma(p[0], p[1], p[2]))
        .collect();

    if s.chroma > 0.0 {
        let r = ((CHROMA_RADIUS * scale).round() as usize).clamp(2, 24);
        for c in 0..3 {
            let diff: Vec<f32> = (0..w * h).map(|i| rgb[i * 3 + c] - y[i]).collect();
            let filtered = guided(&y, &diff, w, h, r, CHROMA_EPS);
            rgb.par_chunks_exact_mut(3)
                .zip(filtered.par_iter().zip(y.par_iter().zip(diff.par_iter())))
                .for_each(|(px, (f, (yy, d)))| {
                    px[c] = yy + d + s.chroma * (f - d);
                });
        }
    }

    if s.luma > 0.0 {
        let r = ((LUMA_RADIUS * scale).round() as usize).clamp(1, 12);
        let smooth = guided(&y, &y, w, h, r, LUMA_EPS);
        rgb.par_chunks_exact_mut(3)
            .zip(y.par_iter().zip(smooth.par_iter()))
            .for_each(|(px, (yy, sm))| {
                if *yy > 1e-6 {
                    let gain = 1.0 + s.luma * (sm / yy - 1.0);
                    px[0] *= gain;
                    px[1] *= gain;
                    px[2] *= gain;
                }
            });
    }

    if s.sharpen > 0.0 {
        let r = ((SHARPEN_RADIUS * scale).round() as usize).clamp(1, 6);
        let blur = box_mean(&y, w, h, r);
        let amount = s.sharpen * SHARPEN_AMOUNT;
        rgb.par_chunks_exact_mut(3)
            .zip(y.par_iter().zip(blur.par_iter()))
            .for_each(|(px, (yy, bl))| {
                if *yy > 1e-6 {
                    let gain = 1.0 + amount * (yy - bl) / yy.max(0.02);
                    let gain = gain.clamp(0.2, 3.0);
                    px[0] *= gain;
                    px[1] *= gain;
                    px[2] *= gain;
                }
            });
    }
}

/// The guided filter: local linear model of `src` on `guide`, box windows.
fn guided(guide: &[f32], src: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    let mg = box_mean(guide, w, h, r);
    let ms = box_mean(src, w, h, r);
    let gs: Vec<f32> = guide.iter().zip(src).map(|(g, s)| g * s).collect();
    let gg: Vec<f32> = guide.iter().map(|g| g * g).collect();
    let mgs = box_mean(&gs, w, h, r);
    let mgg = box_mean(&gg, w, h, r);

    let mut a = vec![0f32; w * h];
    let mut b = vec![0f32; w * h];
    for i in 0..w * h {
        let var = (mgg[i] - mg[i] * mg[i]).max(0.0);
        a[i] = (mgs[i] - mg[i] * ms[i]) / (var + eps);
        b[i] = ms[i] - a[i] * mg[i];
    }
    let ma = box_mean(&a, w, h, r);
    let mb = box_mean(&b, w, h, r);
    (0..w * h).map(|i| ma[i] * guide[i] + mb[i]).collect()
}

/// Box mean with clamped-to-edge windows, via a summed-area table.
fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    // Integral in f64: a 24-megapixel plane summed in f32 loses digits long before the bottom rows.
    let mut sat = vec![0f64; (w + 1) * (h + 1)];
    for yy in 0..h {
        let mut row = 0f64;
        for xx in 0..w {
            row += src[yy * w + xx] as f64;
            sat[(yy + 1) * (w + 1) + xx + 1] = sat[yy * (w + 1) + xx + 1] + row;
        }
    }
    let mut out = vec![0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(yy, orow)| {
        let y0 = yy.saturating_sub(r);
        let y1 = (yy + r + 1).min(h);
        for (xx, o) in orow.iter_mut().enumerate() {
            let x0 = xx.saturating_sub(r);
            let x1 = (xx + r + 1).min(w);
            let sum = sat[y1 * (w + 1) + x1] + sat[y0 * (w + 1) + x0]
                - sat[y0 * (w + 1) + x1]
                - sat[y1 * (w + 1) + x0];
            *o = (sum / ((y1 - y0) * (x1 - x0)) as f64) as f32;
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_field_passes_through_unchanged() {
        let (w, h) = (32, 32);
        let mut rgb: Vec<f32> = (0..w * h).flat_map(|_| [0.3, 0.5, 0.2]).collect();
        let before = rgb.clone();
        apply(&mut rgb, w, h, NrStrength { chroma: 1.0, luma: 1.0, sharpen: 0.0 }, 1.0);
        for (a, b) in rgb.iter().zip(&before) {
            assert!((a - b).abs() < 1e-3, "flat field moved: {a} vs {b}");
        }
    }

    #[test]
    fn chroma_speckle_smooths_while_a_luma_edge_stays() {
        let (w, h) = (48, 48);
        let mut rgb = vec![0f32; w * h * 3];
        for yy in 0..h {
            for xx in 0..w {
                let base = if xx < w / 2 { 0.1 } else { 0.7 };
                let i = (yy * w + xx) * 3;
                let tint = if (xx + yy) % 2 == 0 { 0.04 } else { -0.04 };
                rgb[i] = base + tint;
                rgb[i + 1] = base;
                rgb[i + 2] = base - tint;
            }
        }
        let mut out = rgb.clone();
        apply(&mut out, w, h, NrStrength { chroma: 1.0, luma: 0.0, sharpen: 0.0 }, 1.0);
        let mid = (h / 2 * w + w / 4) * 3;
        let speckle_before = (rgb[mid] - rgb[mid + 3]).abs();
        let speckle_after = (out[mid] - out[mid + 3]).abs();
        assert!(
            speckle_after < speckle_before * 0.3,
            "speckle survived: {speckle_before} -> {speckle_after}"
        );
        let l = crate::pipeline::luma(out[mid], out[mid + 1], out[mid + 2]);
        let ridge = (h / 2 * w + 3 * w / 4) * 3;
        let rl = crate::pipeline::luma(out[ridge], out[ridge + 1], out[ridge + 2]);
        assert!(rl - l > 0.4, "edge blurred away: {l} vs {rl}");
    }
}
