//! Turning a bracket into one photograph: Mertens exposure fusion.
//!
//! Fusion rather than radiance recovery on purpose. The classical HDR route —
//! solve for the camera response, build a floating-point radiance map, tone
//! map it back down — needs the exposure times to be trusted and ends with a
//! tone mapper whose look has to be chosen. Fusion skips both: every pixel of
//! the result is a blend of the *input* pixels that showed it best, so the
//! output already looks like the camera's photographs, just with the shadows
//! taken from the long exposure and the highlights from the short one.
//!
//! "Showed it best" is Mertens' three-part weight: local contrast (a blurred
//! frame knows nothing), saturation (a blown channel greys out), and
//! well-exposedness (distance from mid-grey). The blend happens per level of
//! a Laplacian pyramid, which is what keeps it from looking like a blend —
//! flat regions hand over smoothly across many pixels while edges switch
//! frames within a few.

use rayon::prelude::*;

/// One channel of one frame, f32 in 0..=1, row-major.
#[derive(Clone)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Plane {
    fn new(width: usize, height: usize) -> Self {
        Plane { width, height, data: vec![0.0; width * height] }
    }

    fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }
}

/// The [1 4 6 4 1]/16 binomial blur, one axis at a time, edges clamped.
fn blurred(p: &Plane) -> Plane {
    let mut horizontal = Plane::new(p.width, p.height);
    horizontal
        .data
        .par_chunks_mut(p.width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, out) in row.iter_mut().enumerate() {
                let sample = |o: i32| {
                    let sx = (x as i32 + o).clamp(0, p.width as i32 - 1) as usize;
                    p.at(sx, y)
                };
                *out = (sample(-2) + 4.0 * sample(-1) + 6.0 * sample(0)
                    + 4.0 * sample(1)
                    + sample(2))
                    / 16.0;
            }
        });
    let mut vertical = Plane::new(p.width, p.height);
    vertical
        .data
        .par_chunks_mut(p.width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, out) in row.iter_mut().enumerate() {
                let sample = |o: i32| {
                    let sy = (y as i32 + o).clamp(0, p.height as i32 - 1) as usize;
                    horizontal.at(x, sy)
                };
                *out = (sample(-2) + 4.0 * sample(-1) + 6.0 * sample(0)
                    + 4.0 * sample(1)
                    + sample(2))
                    / 16.0;
            }
        });
    vertical
}

/// Blur, then keep every second pixel — one pyramid step down.
fn downsampled(p: &Plane) -> Plane {
    let smooth = blurred(p);
    let width = (p.width + 1) / 2;
    let height = (p.height + 1) / 2;
    let mut out = Plane::new(width, height);
    out.data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, v) in row.iter_mut().enumerate() {
            *v = smooth.at((x * 2).min(smooth.width - 1), (y * 2).min(smooth.height - 1));
        }
    });
    out
}

/// Back up to (width, height) by bilinear interpolation.
///
/// Collapse uses the same function that built the Laplacian, so the round
/// trip is exact by construction — the interpolant only decides how smoothly
/// the levels hand over, and bilinear is smooth enough at every scale that
/// matters here.
fn upsampled(p: &Plane, width: usize, height: usize) -> Plane {
    let mut out = Plane::new(width, height);
    out.data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let sy = (y as f32) / 2.0;
        let y0 = (sy as usize).min(p.height - 1);
        let y1 = (y0 + 1).min(p.height - 1);
        let fy = sy - y0 as f32;
        for (x, v) in row.iter_mut().enumerate() {
            let sx = (x as f32) / 2.0;
            let x0 = (sx as usize).min(p.width - 1);
            let x1 = (x0 + 1).min(p.width - 1);
            let fx = sx - x0 as f32;
            let top = p.at(x0, y0) * (1.0 - fx) + p.at(x1, y0) * fx;
            let bottom = p.at(x0, y1) * (1.0 - fx) + p.at(x1, y1) * fx;
            *v = top * (1.0 - fy) + bottom * fy;
        }
    });
    out
}

fn gaussian_pyramid(base: Plane, levels: usize) -> Vec<Plane> {
    let mut out = vec![base];
    for _ in 1..levels {
        let next = downsampled(out.last().expect("never empty"));
        out.push(next);
    }
    out
}

/// How deep the pyramids go: down to a handful of pixels, so flat regions
/// blend across the whole picture rather than in visible patches.
fn levels_for(width: usize, height: usize) -> usize {
    let mut extent = width.min(height);
    let mut levels = 1;
    while extent >= 16 && levels < 10 {
        extent /= 2;
        levels += 1;
    }
    levels
}

/// The Mertens weight of every pixel of one frame.
fn weight_of(planes: &[Plane; 3]) -> Plane {
    let [r, g, b] = planes;
    let (width, height) = (r.width, r.height);
    let mut out = Plane::new(width, height);
    out.data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, v) in row.iter_mut().enumerate() {
            let luma = |x: usize, y: usize| {
                0.299 * r.at(x, y) + 0.587 * g.at(x, y) + 0.114 * b.at(x, y)
            };
            let left = x.saturating_sub(1);
            let right = (x + 1).min(width - 1);
            let up = y.saturating_sub(1);
            let down = (y + 1).min(height - 1);
            let contrast = (4.0 * luma(x, y)
                - luma(left, y)
                - luma(right, y)
                - luma(x, up)
                - luma(x, down))
                .abs();

            let (pr, pg, pb) = (r.at(x, y), g.at(x, y), b.at(x, y));
            let mean = (pr + pg + pb) / 3.0;
            let saturation =
                (((pr - mean).powi(2) + (pg - mean).powi(2) + (pb - mean).powi(2)) / 3.0).sqrt();

            let well = |c: f32| (-(c - 0.5).powi(2) / (2.0 * 0.2 * 0.2)).exp();
            let exposedness = well(pr) * well(pg) * well(pb);

            // The epsilon keeps a pixel every frame botched from dividing by
            // zero at normalisation; it decides nothing else.
            *v = contrast * saturation * exposedness + 1e-12;
        }
    });
    out
}

/// Fuse aligned, same-sized frames into one. Panics on none given or on
/// mismatched sizes — the caller aligned these, so both are its bugs.
pub fn exposure_fusion(frames: &[image::RgbImage]) -> image::RgbImage {
    let (width, height) =
        (frames[0].width() as usize, frames[0].height() as usize);
    assert!(frames.iter().all(|f| (f.width() as usize, f.height() as usize) == (width, height)));
    let levels = levels_for(width, height);

    // Weights first, normalised so every pixel's weights sum to one across
    // frames — after that each frame can be folded in on its own.
    let planes_of = |frame: &image::RgbImage| -> [Plane; 3] {
        let mut planes =
            [Plane::new(width, height), Plane::new(width, height), Plane::new(width, height)];
        for (i, pixel) in frame.pixels().enumerate() {
            for c in 0..3 {
                planes[c].data[i] = pixel.0[c] as f32 / 255.0;
            }
        }
        planes
    };

    let mut weights: Vec<Plane> = frames
        .iter()
        .map(|frame| weight_of(&planes_of(frame)))
        .collect();
    let mut total = Plane::new(width, height);
    for w in &weights {
        total.data.par_iter_mut().zip(&w.data).for_each(|(t, v)| *t += v);
    }
    for w in &mut weights {
        w.data.par_iter_mut().zip(&total.data).for_each(|(v, t)| *v /= t);
    }

    // One Laplacian pyramid per channel, accumulated frame by frame under
    // the Gaussian pyramid of that frame's weight.
    let mut fused: Vec<[Plane; 3]> = Vec::new();
    for (frame, weight) in frames.iter().zip(weights) {
        let weight_levels = gaussian_pyramid(weight, levels);
        let channel_planes = planes_of(frame);
        for (c, base) in channel_planes.into_iter().enumerate() {
            let gaussian = gaussian_pyramid(base, levels);
            for level in 0..levels {
                let laplacian: Plane = if level + 1 < levels {
                    let up = upsampled(
                        &gaussian[level + 1],
                        gaussian[level].width,
                        gaussian[level].height,
                    );
                    let mut l = gaussian[level].clone();
                    l.data.par_iter_mut().zip(&up.data).for_each(|(v, u)| *v -= u);
                    l
                } else {
                    gaussian[level].clone()
                };
                if fused.len() <= level {
                    fused.push([
                        Plane::new(laplacian.width, laplacian.height),
                        Plane::new(laplacian.width, laplacian.height),
                        Plane::new(laplacian.width, laplacian.height),
                    ]);
                }
                fused[level][c]
                    .data
                    .par_iter_mut()
                    .zip(&laplacian.data)
                    .zip(&weight_levels[level].data)
                    .for_each(|((acc, v), w)| *acc += v * w);
            }
        }
    }

    // Collapse: start at the coarsest level and add detail back in.
    let mut picture: [Plane; 3] = fused.pop().expect("at least one level");
    while let Some(level) = fused.pop() {
        for c in 0..3 {
            let up = upsampled(&picture[c], level[c].width, level[c].height);
            let mut merged = level[c].clone();
            merged.data.par_iter_mut().zip(&up.data).for_each(|(v, u)| *v += u);
            picture[c] = merged;
        }
    }

    let mut out = image::RgbImage::new(width as u32, height as u32);
    for (i, pixel) in out.pixels_mut().enumerate() {
        for c in 0..3 {
            pixel.0[c] = (picture[c].data[i].clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A colourful scene: a horizontal ramp with a saturated block in it.
    fn scene(width: u32, height: u32) -> image::RgbImage {
        image::RgbImage::from_fn(width, height, |x, y| {
            let ramp = (x * 255 / width.max(1)) as u8;
            if x > width / 3 && x < 2 * width / 3 && y > height / 3 && y < 2 * height / 3 {
                image::Rgb([200, 60, 40])
            } else {
                image::Rgb([ramp, ramp, ramp])
            }
        })
    }

    fn exposed(source: &image::RgbImage, gain: f32) -> image::RgbImage {
        image::RgbImage::from_fn(source.width(), source.height(), |x, y| {
            let p = source.get_pixel(x, y);
            image::Rgb([
                (p.0[0] as f32 * gain).min(255.0) as u8,
                (p.0[1] as f32 * gain).min(255.0) as u8,
                (p.0[2] as f32 * gain).min(255.0) as u8,
            ])
        })
    }

    #[test]
    fn a_bracket_fuses_to_something_between_its_ends() {
        let mid = scene(96, 64);
        let bracket = [exposed(&mid, 0.15), mid.clone(), exposed(&mid, 4.0)];
        let fused = exposure_fusion(&bracket);

        let mean = |img: &image::RgbImage| {
            img.pixels().map(|p| p.0[0] as f64 + p.0[1] as f64 + p.0[2] as f64).sum::<f64>()
                / (img.len() as f64)
        };
        let dark = mean(&bracket[0]);
        let bright = mean(&bracket[2]);
        let result = mean(&fused);
        assert!(result > dark && result < bright, "{dark} !< {result} !< {bright}");
    }

    #[test]
    fn the_well_exposed_frame_wins_where_the_others_clipped() {
        // In the bright frame the block has blown to near-white; in the dark
        // one it has sunk to near-black. The fused block must still be red —
        // taken from the frame that held it.
        let mid = scene(96, 64);
        let bracket = [exposed(&mid, 0.08), mid.clone(), exposed(&mid, 6.0)];
        let fused = exposure_fusion(&bracket);
        let p = fused.get_pixel(48, 32).0;
        assert!(
            p[0] > p[1] + 40 && p[0] > p[2] + 40,
            "the block should still be red, got {p:?}"
        );
    }

    #[test]
    fn one_frame_fuses_to_itself() {
        let only = scene(40, 40);
        let fused = exposure_fusion(&[only.clone()]);
        // Normalised weights of a single frame are all one, so the pyramid
        // round-trip is the identity up to float noise.
        for (a, b) in only.pixels().zip(fused.pixels()) {
            for c in 0..3 {
                assert!((a.0[c] as i16 - b.0[c] as i16).abs() <= 1, "{a:?} vs {b:?}");
            }
        }
    }
}
