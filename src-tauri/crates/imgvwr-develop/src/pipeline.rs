//! Tone is shaped on luminance and applied to RGB as a single gain: one curve evaluation per
//! pixel, and scaling the channels together preserves hue where per-channel curves shift skin tones.

use imgvwr_core::{linear_to_srgb, DecodedImage, LinearImage};
use rayon::prelude::*;

use crate::look::{self, LookTables, LookTuning};
use crate::params::DevelopParams;

/// Scene-linear middle grey — the pivot every tonal control turns around.
pub const MID_GREY: f32 = 0.18;

/// Rec. 709 luminance of linear RGB.
#[inline]
pub fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Slider values reduced to the constants the per-pixel loop needs, computed once per render.
struct Tone {
    exposure_gain: f32,
    shadows: f32,
    highlights: f32,
    whites: f32,
    black_shift: f32,
    contrast_exp: f32,
    /// Where the highlight shoulder starts. At or above 1.0 there is none, and
    /// values past white simply clip.
    knee: f32,
}

impl Tone {
    fn new(p: &DevelopParams) -> Self {
        Self {
            exposure_gain: (p.exposure).exp2(),
            // ±100 maps to ±2.5 EV (shadows) / ±3.2 EV (highlights). The look's curve reaches white
            // near scene 1.0 while the decoder keeps 2+ stops above it; the highlight pull must span that or clipped skies stay clipped.
            shadows: (p.shadows / 100.0) * 2.5,
            highlights: (p.highlights / 100.0) * 3.2,
            whites: (p.whites / 100.0) * 0.5,
            black_shift: (p.blacks / 100.0) * 0.05,
            contrast_exp: (p.contrast / 100.0).exp2(),
            knee: 1.0 - p.rolloff / 100.0,
        }
    }
}

/// Below the knee nothing happens; above it the range bends into an asymptote at white.
/// Exponential: the slope is untouched at the knee (no seam), white is approached but never reached, and it is monotone for every parameter — which no fitted spline guarantees.
#[inline]
fn shoulder(y: f32, knee: f32) -> f32 {
    if knee >= 1.0 || y <= knee {
        return y;
    }
    let span = 1.0 - knee;
    knee + span * (1.0 - ((knee - y) / span).exp())
}

/// Scene-linear luminance in, luminance out; must stay monotone — a curve that folds back posterises.
fn tone_curve(y: f32, t: &Tone) -> f32 {
    let y = y * t.exposure_gain;

    // w: 0 at black, 0.5 at middle grey, tending to 1 in the highlights; bounded for any input.
    let w = y / (y + MID_GREY);
    let shadow_mask = (1.0 - w) * (1.0 - w) * (1.0 - w);
    let highlight_mask = w * w * w;

    // Slope stays positive for any slider: |y·d(mask)/dy| ≤ 0.32 and 3.2·ln2·0.32 < 1; the cubic masks keep middle grey out of both.
    let y = y * (t.shadows * shadow_mask + t.highlights * highlight_mask).exp2();
    let y = y * (1.0 + t.whites * w * w);
    let y = y + t.black_shift;

    if y <= 0.0 {
        return 0.0;
    }
    let y = if t.contrast_exp == 1.0 {
        y
    } else {
        MID_GREY * (y / MID_GREY).powf(t.contrast_exp)
    };

    // The shoulder goes last: it is the only stage that knows where white is.
    shoulder(y, t.knee)
}

/// Apply an edit to scene-linear pixels, producing display-ready sRGB RGBA8.
pub fn develop(src: &LinearImage, params: &DevelopParams) -> DecodedImage {
    develop_looked(src, params, None)
}

pub fn develop_looked(
    src: &LinearImage,
    params: &DevelopParams,
    look: Option<&LookTuning>,
) -> DecodedImage {
    develop_looked_nr(src, params, look, crate::nr::NrStrength::NONE, 1.0)
}

/// One pixel through tone and look: scene-linear in, display-linear out.
#[inline]
fn toned_looked(inp: &[f32], tone: &Tone, tables: &Option<LookTables>) -> (f32, f32, f32) {
    let (mut r, mut g, mut b) = (inp[0], inp[1], inp[2]);

    // Luminance from the non-negative part of each channel: UV-lit violet arrives with green
    // negative enough to zero the raw weighted sum, and ranking that bright blue pixel "black" punched black holes in UV-lit fabric.
    let y0 = luma(r.max(0.0), g.max(0.0), b.max(0.0));
    let y1 = tone_curve(y0, tone);
    if y0 > 1e-6 {
        let gain = y1 / y0;
        r *= gain;
        g *= gain;
        b *= gain;
    } else {
        // Black pixel: a lifted black point still has to show up, and does so neutrally.
        r = y1;
        g = y1;
        b = y1;
    }

    if let Some(tables) = tables {
        (r, g, b) = look::apply_pixel(r, g, b, tables);
    }
    (r, g, b)
}

/// Saturation/vibrance and the sRGB encode: display-linear in, RGBA8 out.
#[inline]
fn finish_pixel(mut r: f32, mut g: f32, mut b: f32, sat: f32, vib: f32, out: &mut [u8]) {
    if sat != 0.0 || vib != 0.0 {
        let y = luma(r, g, b);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        // Clamped, not merely divided: out-of-gamut negative channels push the ratio past 1, and
        // vibrance would then read the most saturated pixels as "more than fully saturated" and drain them.
        let current = if max > 1e-6 {
            ((max - min) / max).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let factor = (1.0 + sat + vib * (1.0 - current)).max(0.0);
        r = y + (r - y) * factor;
        g = y + (g - y) * factor;
        b = y + (b - y) * factor;
    }
    out[0] = encode(r);
    out[1] = encode(g);
    out[2] = encode(b);
    out[3] = 255;
}

/// Sliders run first, in scene light: highlight recovery moves values under white before the look's curve decides where white is; with every slider at zero the output is exactly the camera's rendering.
/// When NR is active the render goes through a display-linear float buffer so the guided filter can see neighbourhoods.
pub fn develop_looked_nr(
    src: &LinearImage,
    params: &DevelopParams,
    look: Option<&LookTuning>,
    nr: crate::nr::NrStrength,
    scale: f32,
) -> DecodedImage {
    let params = params.clamped();
    let tone = Tone::new(&params);
    let tables = look.map(LookTables::new);

    let sat = params.saturation / 100.0;
    let vib = params.vibrance / 100.0;

    let w = src.width as usize;
    let h = src.height as usize;
    let mut rgba = vec![0u8; w * h * 4];

    if nr.active() && tables.is_some() {
        let mut disp = vec![0f32; w * h * 3];
        disp.par_chunks_mut(w * 3)
            .zip(src.rgb.par_chunks(w * 3))
            .for_each(|(out_row, in_row)| {
                for (out, inp) in out_row.chunks_exact_mut(3).zip(in_row.chunks_exact(3)) {
                    let (r, g, b) = toned_looked(inp, &tone, &tables);
                    out[0] = r;
                    out[1] = g;
                    out[2] = b;
                }
            });
        crate::nr::apply(&mut disp, w, h, nr, scale);
        rgba.par_chunks_mut(w * 4)
            .zip(disp.par_chunks(w * 3))
            .for_each(|(out_row, in_row)| {
                for (out, inp) in out_row.chunks_exact_mut(4).zip(in_row.chunks_exact(3)) {
                    finish_pixel(inp[0], inp[1], inp[2], sat, vib, out);
                }
            });
    } else {
        rgba.par_chunks_mut(w * 4)
            .zip(src.rgb.par_chunks(w * 3))
            .for_each(|(out_row, in_row)| {
                for (out, inp) in out_row.chunks_exact_mut(4).zip(in_row.chunks_exact(3)) {
                    let (r, g, b) = toned_looked(inp, &tone, &tables);
                    finish_pixel(r, g, b, sat, vib, out);
                }
            });
    }

    DecodedImage {
        width: src.width,
        height: src.height,
        rgba,
    }
}

#[inline]
fn encode(v: f32) -> u8 {
    let clamped = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    (linear_to_srgb(clamped) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::DevelopParams;

    fn linear(pixels: &[[f32; 3]]) -> LinearImage {
        LinearImage {
            width: pixels.len() as u32,
            height: 1,
            rgb: pixels.iter().flatten().copied().collect(),
        }
    }

    fn tone_of(p: DevelopParams) -> Tone {
        Tone::new(&p.clamped())
    }

    #[test]
    fn identity_params_leave_luminance_alone() {
        let t = tone_of(DevelopParams::default());
        for y in [0.0, 0.01, MID_GREY, 0.5, 1.0, 4.0] {
            assert!((tone_curve(y, &t) - y).abs() < 1e-6, "y = {y}");
        }
    }

    #[test]
    fn exposure_is_stops() {
        let t = tone_of(DevelopParams {
            exposure: 1.0,
            ..Default::default()
        });
        assert!((tone_curve(0.1, &t) - 0.2).abs() < 1e-6);
        let down = tone_of(DevelopParams {
            exposure: -2.0,
            ..Default::default()
        });
        assert!((tone_curve(0.4, &down) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn contrast_pivots_on_middle_grey() {
        let t = tone_of(DevelopParams {
            contrast: 100.0,
            ..Default::default()
        });
        assert!((tone_curve(MID_GREY, &t) - MID_GREY).abs() < 1e-5);
        assert!(tone_curve(0.05, &t) < 0.05);
        assert!(tone_curve(0.5, &t) > 0.5);
    }

    #[test]
    fn shadows_and_highlights_act_on_their_own_ends() {
        let lift = tone_of(DevelopParams {
            shadows: 100.0,
            ..Default::default()
        });
        let dark_before = 0.01;
        let bright_before = 4.0;
        assert!(tone_curve(dark_before, &lift) > dark_before * 1.5, "shadows lift");
        let bright_after = tone_curve(bright_before, &lift);
        assert!(
            (bright_after / bright_before - 1.0).abs() < 0.05,
            "highlights held: {bright_after}"
        );

        let recover = tone_of(DevelopParams {
            highlights: -100.0,
            ..Default::default()
        });
        assert!(tone_curve(bright_before, &recover) < bright_before * 0.5);
        assert!((tone_curve(0.001, &recover) / 0.001 - 1.0).abs() < 0.05);
    }

    #[test]
    fn the_curve_is_monotonic_for_extreme_slider_combinations() {
        for &contrast in &[-100.0, 0.0, 100.0] {
            for &shadows in &[-100.0, 100.0] {
                for &highlights in &[-100.0, 100.0] {
                    for &whites in &[-100.0, 100.0] {
                        for &blacks in &[-100.0, 100.0] {
                          for &rolloff in &[0.0, 50.0, 100.0] {
                            let t = tone_of(DevelopParams {
                                exposure: 0.0,
                                contrast,
                                shadows,
                                highlights,
                                whites,
                                blacks,
                                rolloff,
                                vibrance: 0.0,
                                saturation: 0.0,
                            });
                            let mut prev = tone_curve(0.0, &t);
                            for step in 1..=400 {
                                let y = step as f32 / 100.0;
                                let cur = tone_curve(y, &t);
                                assert!(
                                    cur >= prev - 1e-5,
                                    "not monotonic at y={y}: {prev} → {cur} (c={contrast} \
                                     s={shadows} h={highlights} w={whites} b={blacks} r={rolloff})"
                                );
                                assert!(cur.is_finite(), "non-finite at y={y}");
                                prev = cur;
                            }
                          }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_shoulder_is_off_until_asked_for() {
        let t = tone_of(DevelopParams::default());
        for y in [0.0, MID_GREY, 0.9, 1.0, 2.0, 8.0] {
            assert!((tone_curve(y, &t) - y).abs() < 1e-6, "y = {y}");
        }
    }

    #[test]
    fn the_shoulder_keeps_highlights_separated_instead_of_clipping() {
        let plain = tone_of(DevelopParams::default());
        let rolled = tone_of(DevelopParams {
            rolloff: 70.0,
            ..Default::default()
        });

        let bright = [1.2f32, 1.8, 3.0, 6.0];
        let flat: Vec<u8> = bright.iter().map(|y| encode(tone_curve(*y, &plain))).collect();
        assert!(flat.iter().all(|v| *v == 255), "clipped without one: {flat:?}");

        let separated: Vec<u8> = bright
            .iter()
            .map(|y| encode(tone_curve(*y, &rolled)))
            .collect();
        for pair in separated.windows(2) {
            assert!(
                pair[1] > pair[0],
                "highlights must keep pulling apart: {separated:?}"
            );
        }
        // Real NEFs measure a bit over 3× white at most; past ~11× the exponential falls under f32 epsilon and rounds to exactly white.
        for y in [3.5f32, 6.0, 8.0] {
            let out = tone_curve(y, &rolled);
            assert!(out < 1.0, "reached white at {y}: {out}");
        }
    }

    #[test]
    fn the_shoulder_leaves_the_midtones_where_they_were() {
        let t = tone_of(DevelopParams {
            rolloff: 40.0,
            ..Default::default()
        });
        for y in [0.01, 0.1, MID_GREY, 0.5] {
            assert!((tone_curve(y, &t) - y).abs() < 1e-6, "moved {y}");
        }
    }

    #[test]
    fn develop_preserves_hue_under_exposure() {
        let src = linear(&[[0.2, 0.1, 0.05]]);
        let out = develop(
            &src,
            &DevelopParams {
                exposure: 1.0,
                ..Default::default()
            },
        );
        let (r, g, b) = (out.rgba[0] as f32, out.rgba[1] as f32, out.rgba[2] as f32);
        assert!(r > g && g > b, "ordering held: {r} {g} {b}");
        let plain = develop(&src, &DevelopParams::default());
        assert!(out.rgba[0] > plain.rgba[0], "brighter after +1 EV");
    }

    #[test]
    fn saturation_zero_produces_grey() {
        let src = linear(&[[0.4, 0.1, 0.02]]);
        let out = develop(
            &src,
            &DevelopParams {
                saturation: -100.0,
                ..Default::default()
            },
        );
        assert_eq!(out.rgba[0], out.rgba[1]);
        assert_eq!(out.rgba[1], out.rgba[2]);
    }

    #[test]
    fn vibrance_spares_colours_that_are_already_vivid() {
        // Measured not as "which pixel moves more" (a saturated pixel has more spread to move)
        // but as the fraction of a flat saturation move each pixel receives.
        let dull = linear(&[[0.20, 0.19, 0.18]]);
        let vivid = linear(&[[0.40, 0.02, 0.02]]);
        let spread = |img: &DecodedImage| {
            let (r, g, b) = (img.rgba[0] as f32, img.rgba[1] as f32, img.rgba[2] as f32);
            r.max(g).max(b) - r.min(g).min(b)
        };
        let gain_ratio = |src: &LinearImage| {
            let base = spread(&develop(src, &DevelopParams::default()));
            let vib = spread(&develop(
                src,
                &DevelopParams {
                    vibrance: 100.0,
                    ..Default::default()
                },
            ));
            let sat = spread(&develop(
                src,
                &DevelopParams {
                    saturation: 100.0,
                    ..Default::default()
                },
            ));
            (vib - base) / (sat - base).max(1e-6)
        };

        let dull_ratio = gain_ratio(&dull);
        let vivid_ratio = gain_ratio(&vivid);
        assert!(
            dull_ratio > 0.8,
            "a dull colour gets almost the full move: {dull_ratio}"
        );
        assert!(
            vivid_ratio < 0.2,
            "a vivid colour is largely spared: {vivid_ratio}"
        );
    }

    #[test]
    fn vibrance_does_not_invert_on_colours_outside_the_srgb_gamut() {
        // Out-of-gamut green with negative channels: 0.4–3.6% of real NEF samples land here.
        let out_of_gamut = linear(&[[-0.03, 0.42, -0.01]]);
        let spread = |img: &DecodedImage| {
            let (r, g, b) = (img.rgba[0] as i32, img.rgba[1] as i32, img.rgba[2] as i32);
            r.max(g).max(b) - r.min(g).min(b)
        };
        let base = spread(&develop(&out_of_gamut, &DevelopParams::default()));
        let vibed = spread(&develop(
            &out_of_gamut,
            &DevelopParams {
                vibrance: 100.0,
                ..Default::default()
            },
        ));
        assert!(
            vibed >= base,
            "vibrance drained an out-of-gamut colour: {base} → {vibed}"
        );
    }

    #[test]
    fn highlights_above_one_are_recoverable_not_pre_clipped() {
        let src = linear(&[[3.0, 2.8, 2.6]]);
        let clipped = develop(&src, &DevelopParams::default());
        assert_eq!(clipped.rgba[0], 255, "unrecovered highlight clips");
        let recovered = develop(
            &src,
            &DevelopParams {
                highlights: -100.0,
                exposure: -1.0,
                ..Default::default()
            },
        );
        assert!(recovered.rgba[0] < 250, "detail returns: {}", recovered.rgba[0]);
    }

    #[test]
    fn output_is_opaque_and_correctly_sized() {
        let src = linear(&[[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
        let out = develop(&src, &DevelopParams::default());
        assert_eq!((out.width, out.height), (2, 1));
        assert_eq!(out.rgba.len(), 2 * 4);
        assert_eq!(out.rgba[3], 255);
        assert_eq!(out.rgba[7], 255);
    }

    #[test]
    fn ultraviolet_violet_renders_as_colour_not_as_a_black_hole() {
        // Green negative enough to drag the raw luminance to zero while the pixel is plainly bright blue.
        let src = linear(&[[0.02, -0.09, 0.35]]);
        let out = develop(&src, &DevelopParams::default());
        assert!(out.rgba[2] > 100, "blue survives: {:?}", &out.rgba[..3]);
        let tables = crate::look::LookTables::new(&crate::look::LookTuning::NEUTRAL);
        let (_, _, b) = crate::look::apply_pixel(0.02, -0.09, 0.35, &tables);
        assert!(b > 0.3, "and through the look too: {b}");
    }

    #[test]
    fn non_finite_input_pixels_do_not_leak_into_the_output() {
        let src = linear(&[[f32::NAN, f32::INFINITY, -1.0]]);
        let out = develop(&src, &DevelopParams::default());
        assert_eq!(out.rgba[0], 0, "NaN renders as black, not garbage");
        assert_eq!(out.rgba[2], 0, "a negative sample clamps to black");
        assert_eq!(out.rgba[3], 255, "and the pixel stays opaque");
    }
}
