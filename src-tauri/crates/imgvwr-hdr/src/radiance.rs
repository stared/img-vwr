//! Scene-linear radiance from an aligned bracket: 1.0 is the reference frame's diffuse white,
//! with the highlights darker exposures kept live above it. Exposure gains are measured
//! photometrically (median ratio of mutually well-exposed pixels between exposure-adjacent
//! frames), not read from EXIF — edited, transcoded or stripped files still measure correctly.

use rayon::prelude::*;

use crate::Aligned;
use crate::MergedRadiance;

/// Encoded values outside these no longer measure the scene: crushed toe, clipped shoulder.
const LOW: f32 = 0.02;
const HIGH: f32 = 0.97;

fn srgb_lut() -> [f32; 256] {
    let mut lut = [0f32; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let e = i as f32 / 255.0;
        *slot = if e <= 0.04045 { e / 12.92 } else { ((e + 0.055) / 1.055).powf(2.4) };
    }
    lut
}

/// Zero at toe and shoulder, most in the middle; only relative weight matters.
fn trust(encoded: f32) -> f32 {
    ((encoded - LOW) * (HIGH - encoded)).max(0.0)
}

/// Gain of `b` relative to `a`: the median linear ratio over pixels both frames measured well.
fn gain_between(a: &image::RgbImage, b: &image::RgbImage, lut: &[f32; 256]) -> f32 {
    const STRIDE: u32 = 7;
    let mut ratios: Vec<f32> = Vec::new();
    let (w, h) = (a.width(), a.height());
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let pa = a.get_pixel(x, y).0;
            let pb = b.get_pixel(x, y).0;
            let la = 0.299 * lut[pa[0] as usize] + 0.587 * lut[pa[1] as usize] + 0.114 * lut[pa[2] as usize];
            let lb = 0.299 * lut[pb[0] as usize] + 0.587 * lut[pb[1] as usize] + 0.114 * lut[pb[2] as usize];
            let ea = pa.iter().map(|&c| c as f32 / 255.0).fold(0.0, f32::max);
            let eb = pb.iter().map(|&c| c as f32 / 255.0).fold(0.0, f32::max);
            if ea > LOW && ea < HIGH && eb > LOW && eb < HIGH && la > 1e-4 {
                ratios.push(lb / la);
            }
            x += STRIDE;
        }
        y += STRIDE;
    }
    if ratios.is_empty() {
        return 1.0;
    }
    ratios.sort_by(|p, q| p.partial_cmp(q).expect("ratios are finite"));
    ratios[ratios.len() / 2]
}

pub(crate) fn radiance_of(aligned: Aligned) -> MergedRadiance {
    let lut = srgb_lut();
    let (width, height) = {
        let first = &aligned.frames[0].1;
        (first.width(), first.height())
    };

    // Ordered by exposure so gains compose along adjacent frames — those with the most pixels in common.
    let mut by_light: Vec<usize> = (0..aligned.frames.len()).collect();
    let mean = |img: &image::RgbImage| -> u64 {
        img.pixels().map(|p| p.0[0] as u64 + p.0[1] as u64 + p.0[2] as u64).sum::<u64>()
            / (3 * img.width() as u64 * img.height() as u64).max(1)
    };
    by_light.sort_by_key(|&at| mean(&aligned.frames[at].1));

    // Gains compose outward from the reference through adjacent pairs; gain > 1 means the frame captured more light.
    let reference_at = by_light
        .iter()
        .position(|&at| aligned.frames[at].0 == aligned.reference)
        .expect("the reference always survives alignment");
    let mut gains = vec![1.0f32; aligned.frames.len()];
    for k in reference_at + 1..by_light.len() {
        let step = gain_between(&aligned.frames[by_light[k - 1]].1, &aligned.frames[by_light[k]].1, &lut);
        gains[by_light[k]] = gains[by_light[k - 1]] * step;
    }
    for k in (0..reference_at).rev() {
        let step = gain_between(&aligned.frames[by_light[k + 1]].1, &aligned.frames[by_light[k]].1, &lut);
        gains[by_light[k]] = gains[by_light[k + 1]] * step;
    }

    // Pixels no frame measured well: clipped highlights take the darkest frame's word, crushed shadows the brightest's.
    let darkest = by_light[0];
    let brightest = *by_light.last().expect("at least two frames");

    let rgb: Vec<f32> = (0..height as usize)
        .into_par_iter()
        .flat_map_iter(|y| {
            let mut row = Vec::with_capacity(width as usize * 3);
            for x in 0..width {
                let mut sum = [0f32; 3];
                let mut weight = 0f32;
                for (at, (_, frame)) in aligned.frames.iter().enumerate() {
                    let p = frame.get_pixel(x, y as u32).0;
                    let brightest_channel = p.iter().map(|&c| c as f32 / 255.0).fold(0.0, f32::max);
                    let w = trust(brightest_channel);
                    if w > 0.0 {
                        for c in 0..3 {
                            sum[c] += w * lut[p[c] as usize] / gains[at];
                        }
                        weight += w;
                    }
                }
                if weight > 0.0 {
                    for c in sum {
                        row.push(c / weight);
                    }
                } else {
                    let probe = aligned.frames[brightest].1.get_pixel(x, y as u32).0;
                    let lit = probe.iter().any(|&c| c as f32 / 255.0 > HIGH);
                    let at = if lit { darkest } else { brightest };
                    let p = aligned.frames[at].1.get_pixel(x, y as u32).0;
                    for c in 0..3 {
                        row.push(lut[p[c] as usize] / gains[at]);
                    }
                }
            }
            row
        })
        .collect();

    MergedRadiance {
        width,
        height,
        rgb,
        reference: aligned.reference,
        motions: aligned.motions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::align::Rigid;

    fn bracket_of(scene_linear: &[f32], width: u32, height: u32, gains: &[f32]) -> Aligned {
        let encode = |linear: f32| -> u8 {
            let e = if linear <= 0.0031308 { linear * 12.92 } else { 1.055 * linear.powf(1.0 / 2.4) - 0.055 };
            (e.clamp(0.0, 1.0) * 255.0).round() as u8
        };
        let frames = gains
            .iter()
            .enumerate()
            .map(|(i, &gain)| {
                let img = image::RgbImage::from_fn(width, height, |x, y| {
                    let v = scene_linear[(y * width + x) as usize] * gain;
                    image::Rgb([encode(v), encode(v), encode(v)])
                });
                (i, img)
            })
            .collect();
        Aligned {
            frames,
            reference: 1,
            motions: gains.iter().map(|_| Some(Rigid::IDENTITY)).collect(),
        }
    }

    #[test]
    fn radiance_recovers_headroom_the_reference_clipped() {
        // The middle exposure clips everything above 1.0; the 1/8 frame keeps it.
        let width = 64u32;
        let height = 64u32;
        let levels = [0.02f32, 0.1, 0.3, 0.7, 2.0, 4.0];
        let scene: Vec<f32> = (0..width * height)
            .map(|i| levels[(i as usize / 8) % levels.len()])
            .collect();
        let merged = radiance_of(bracket_of(&scene, width, height, &[0.125, 1.0, 4.0]));

        let sample = |value: f32| -> f32 {
            let at = scene.iter().position(|&v| v == value).expect("value present");
            merged.rgb[at * 3]
        };
        assert!((sample(0.3) - 0.3).abs() < 0.03, "midtone: {}", sample(0.3));
        assert!((sample(2.0) - 2.0).abs() < 0.3, "headroom: {}", sample(2.0));
        assert!((sample(4.0) - 4.0).abs() < 0.6, "deep headroom: {}", sample(4.0));
        assert!((sample(0.02) - 0.02).abs() < 0.01, "shadow: {}", sample(0.02));
    }
}
