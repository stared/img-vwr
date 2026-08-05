//! Analysis over developed pixels: the live histogram and the focus map.

use imgvwr_core::{DecodedImage, LinearImage};
use rayon::prelude::*;
use serde::Serialize;

use crate::pipeline::{luma, MID_GREY};

/// 256-bin distributions of the *developed* image — what the user is actually
/// looking at, so clipping shown here is clipping they can see. (The info
/// panel's histogram is a different thing: it describes the file on disk.)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    pub luma: Vec<u32>,
    pub red: Vec<u32>,
    pub green: Vec<u32>,
    pub blue: Vec<u32>,
    /// Pixels pinned at 0 and at 255 — the numbers behind a clipping warning.
    pub clipped_shadows: u32,
    pub clipped_highlights: u32,
}

pub fn histogram(img: &DecodedImage) -> Histogram {
    let mut red = vec![0u32; 256];
    let mut green = vec![0u32; 256];
    let mut blue = vec![0u32; 256];
    let mut luma_bins = vec![0u32; 256];
    let mut clipped_shadows = 0u32;
    let mut clipped_highlights = 0u32;

    for px in img.rgba.chunks_exact(4) {
        let (r, g, b) = (px[0], px[1], px[2]);
        red[r as usize] += 1;
        green[g as usize] += 1;
        blue[b as usize] += 1;
        // Rec. 709 on the encoded values: this histogram describes the
        // displayed image, so it is computed in display terms.
        let y = 0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b);
        luma_bins[(y.round() as usize).min(255)] += 1;

        // Asymmetric, and `composite_clipping` marks exactly these pixels —
        // see there for why one channel is enough at the top and not at the
        // bottom.
        if r == 0 && g == 0 && b == 0 {
            clipped_shadows += 1;
        }
        if r == 255 || g == 255 || b == 255 {
            clipped_highlights += 1;
        }
    }

    Histogram {
        luma: luma_bins,
        red,
        green,
        blue,
        clipped_shadows,
        clipped_highlights,
    }
}

/// Per-pixel "how much fine detail is resolved here", normalised to 0..1.
///
/// A Laplacian picks out local contrast at the pixel scale — exactly what
/// focus produces and defocus destroys — and a box average turns that spiky
/// per-edge response into a smooth regional score. It is computed on the
/// logarithm of luminance so a dark in-focus area scores like a bright one
/// rather than being dismissed for having less absolute contrast.
///
/// Honest limitation: this measures resolved detail, so a genuinely smooth
/// surface (clear sky, a white wall) reads as unsharp because there is no
/// detail there to resolve. That is why the overlay marks sharp regions
/// rather than shading everything by score.
pub fn sharpness_map(src: &LinearImage) -> Vec<f32> {
    let w = src.width as usize;
    let h = src.height as usize;
    if w < 3 || h < 3 {
        return vec![0.0; w * h];
    }

    // Log luminance: detail relative to local brightness, not absolute.
    let log_luma: Vec<f32> = src
        .rgb
        .par_chunks(3)
        .map(|px| (luma(px[0], px[1], px[2]).max(0.0) + 1e-4).ln())
        .collect();

    let mut energy = vec![0f32; w * h];
    energy
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            if y == 0 || y + 1 >= h {
                return;
            }
            for x in 1..w - 1 {
                let c = log_luma[y * w + x];
                let lap = 4.0 * c
                    - log_luma[y * w + x - 1]
                    - log_luma[y * w + x + 1]
                    - log_luma[(y - 1) * w + x]
                    - log_luma[(y + 1) * w + x];
                row[x] = lap.abs();
            }
        });

    // Regional average, scaled to the image so the window means the same
    // thing at preview size as at full resolution.
    let radius = (w.max(h) / 200).clamp(2, 12);
    let smoothed = box_blur(&energy, w, h, radius);

    // Normalise against a high percentile rather than the maximum: a single
    // specular glint would otherwise flatten the whole map to nothing.
    //
    // The floor matters as much as the percentile. Without it, an image with
    // no detail anywhere (a flat field, or a sky) normalises its own rounding
    // error up to full scale and the overlay reports confident nonsense. A
    // Laplacian of 0.02 in log-luminance is roughly a 2% local brightness
    // step — below that there is nothing worth calling detail.
    const MIN_REFERENCE: f32 = 0.02;
    let reference = high_percentile(&smoothed, 0.98).max(MIN_REFERENCE);
    smoothed
        .into_par_iter()
        .map(|v| (v / reference).clamp(0.0, 1.0))
        .collect()
}

/// Separable box blur — two O(n) passes with a running sum.
fn box_blur(src: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let base = y * w;
        for x in 0..w {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius).min(w - 1);
            let sum: f32 = src[base + lo..=base + hi].iter().sum();
            row[x] = sum / (hi - lo + 1) as f32;
        }
    });

    let mut out = vec![0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let lo = y.saturating_sub(radius);
        let hi = (y + radius).min(h - 1);
        let n = (hi - lo + 1) as f32;
        for (x, slot) in row.iter_mut().enumerate() {
            let mut sum = 0f32;
            for yy in lo..=hi {
                sum += tmp[yy * w + x];
            }
            *slot = sum / n;
        }
    });
    out
}

/// Value at the given quantile, via a coarse histogram — exact ordering is
/// not worth a full sort of a multi-megapixel buffer.
fn high_percentile(values: &[f32], quantile: f32) -> f32 {
    let max = values.iter().copied().fold(0f32, f32::max);
    if max <= 0.0 {
        return 0.0;
    }
    const BINS: usize = 512;
    let mut hist = [0u32; BINS];
    for &v in values {
        let bin = ((v / max) * (BINS - 1) as f32) as usize;
        hist[bin.min(BINS - 1)] += 1;
    }
    let target = (values.len() as f32 * quantile) as u32;
    let mut seen = 0u32;
    for (i, count) in hist.iter().enumerate() {
        seen += count;
        if seen >= target {
            return (i as f32 / (BINS - 1) as f32) * max;
        }
    }
    max
}

/// How much a region's detail should be believed, from how much light it got.
///
/// [`sharpness_map`] measures contrast in *log* luminance, which is what makes
/// it work across a frame's whole brightness range — a face in shadow scores
/// like a face in sun. The cost is that the same division makes deep shadow
/// enormously sensitive: at ISO 4000, sensor noise a thousandth of mid-grey
/// is a large relative modulation, and a black floor comes out looking like
/// the most finely resolved thing in the picture. Which it is, technically,
/// and uselessly — that is grain, not the subject.
///
/// So the score is weighted by light. The ramp is deliberately gentle and
/// reaches full weight well below mid-grey: a face lit at a fraction of a
/// stop under is still a face, and only genuinely dark regions — where the
/// signal really is mostly noise — are discounted.
fn lit_enough(src: &LinearImage) -> Vec<f32> {
    /// Full confidence at and above this, ramping from zero at black.
    const ENOUGH: f32 = MID_GREY / 3.0;

    let w = src.width as usize;
    let h = src.height as usize;
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let luma: Vec<f32> = src
        .rgb
        .par_chunks(3)
        .map(|px| luma(px[0], px[1], px[2]).max(0.0))
        .collect();
    // Regionally averaged, on the same scale the detail score uses, so the
    // two describe the same neighbourhood.
    let radius = (w.max(h) / 200).clamp(2, 12);
    box_blur(&luma, w, h, radius)
        .into_par_iter()
        .map(|y| (y / ENOUGH).clamp(0.0, 1.0))
        .collect()
}

/// A gentle preference for the middle of the frame.
///
/// "Sharpest" and "the subject" are not the same thing, and where they differ
/// this is the tie-breaker. A hard shadow edge across a floor is genuinely as
/// resolved as a face — more so, often, since a face is soft — so detail
/// alone will happily point at the floor. What the floor is not is where a
/// photographer put the subject.
///
/// Deliberately shallow, and deliberately not a circle. It falls to a little
/// over half weight in the corners, which is enough to settle a close contest
/// and nowhere near enough to override a clear winner off-centre — a subject
/// on a thirds line keeps almost all of its score. This is the same
/// assumption every camera's centre-weighted metering makes, for the same
/// reason: it is usually right and cheap to be wrong about.
fn near_the_middle(w: usize, h: usize) -> Vec<f32> {
    /// Weight at the very corners.
    const CORNER: f32 = 0.55;

    let mut out = vec![0f32; w * h];
    for y in 0..h {
        // Normalised distance from the centre along each axis, 0 at the
        // middle and 1 at the edge.
        let dy = if h <= 1 { 0.0 } else { (y as f32 / (h - 1) as f32 - 0.5).abs() * 2.0 };
        for x in 0..w {
            let dx = if w <= 1 { 0.0 } else { (x as f32 / (w - 1) as f32 - 0.5).abs() * 2.0 };
            // Squared distance, so the falloff is flat across the middle
            // and only bites near the edges.
            let d = (dx * dx + dy * dy) / 2.0;
            out[y * w + x] = 1.0 - (1.0 - CORNER) * d;
        }
    }
    out
}

/// Where in the frame the photograph is sharpest, in normalised coordinates.
///
/// What a photographer checks first: whether the thing that was meant to be
/// in focus is. On a portrait that is the eyes, on a landscape the near
/// texture — in both cases the place resolving the most fine detail, which is
/// exactly what [`sharpness_map`] scores.
///
/// The peak of a *blurred* score rather than of a single pixel: the map is
/// already regionally averaged, so its maximum names an area worth looking
/// at, not a lucky noise spike. A frame with no detail anywhere (a blank wall,
/// a sky) scores below the map's floor everywhere and gets the centre, which
/// is the honest answer to "where is the detail" when there is none.
pub fn focus_point(src: &LinearImage) -> (f32, f32) {
    focus_candidates(src, 1).first().copied().unwrap_or((0.5, 0.5))
}

/// Below this the map is reporting noise, not resolved detail.
const WORTH_POINTING_AT: f32 = 0.35;

/// The places in this frame worth *looking* at, best first.
///
/// A downscaled frame cannot answer "is this in focus". Defocus that spans
/// thirty pixels on a 6000-pixel sensor spans two by the time the frame is
/// 500 across, and two pixels of softness is what a downscale produces
/// anyway — so at preview size an out-of-focus cable and an in-focus eyelash
/// score the same, and lit grass beats both because grass is all edges. That
/// is how the loupe ended up pointed at blurred foreground in a frame whose
/// subject was perfectly sharp.
///
/// So this stops claiming to know. It nominates: a handful of places that
/// have enough detail, enough light, and are not all the same place — and
/// something that can see actual pixels decides between them. Held apart by
/// [`APART`] because five candidates on one bright blob is one candidate.
pub fn focus_candidates(src: &LinearImage, want: usize) -> Vec<(f32, f32)> {
    /// How far apart candidates must be, as a share of the longer edge.
    const APART: f32 = 0.18;
    /// A candidate this much worse than the best is not a contender.
    const RELATIVE_FLOOR: f32 = 0.4;

    let (w, h) = (src.width as usize, src.height as usize);
    if w == 0 || h == 0 || want == 0 {
        return Vec::new();
    }
    // Detail, discounted where there is not enough light for detail to be
    // what it looks like (`lit_enough`), and again towards the edges of the
    // frame (`near_the_middle`).
    let bias = near_the_middle(w, h);
    let mut scored: Vec<f32> = sharpness_map(src)
        .into_iter()
        .zip(lit_enough(src))
        .zip(bias)
        .map(|((detail, lit), central)| detail * lit * central)
        .collect();

    let reach = ((w.max(h) as f32 * APART) as usize).max(1);
    let mut out = Vec::with_capacity(want);
    let mut best_score = 0.0f32;
    while out.len() < want {
        let Some((at, &score)) = scored
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        else {
            break;
        };
        if score < WORTH_POINTING_AT || score < best_score * RELATIVE_FLOOR {
            break;
        }
        best_score = best_score.max(score);
        let (cx, cy) = (at % w, at / w);
        // Pixel centres, so the point is inside the pixel it names.
        out.push((
            cx as f32 / w as f32 + 0.5 / w as f32,
            cy as f32 / h as f32 + 0.5 / h as f32,
        ));
        // Take this whole neighbourhood out of the running, so the next
        // candidate is somewhere else rather than the pixel next door.
        for y in cy.saturating_sub(reach)..(cy + reach + 1).min(h) {
            for x in cx.saturating_sub(reach)..(cx + reach + 1).min(w) {
                scored[y * w + x] = 0.0;
            }
        }
    }
    out
}

/// How much detail this patch of pixels actually resolves, on a scale that
/// means the same thing from one patch to the next.
///
/// The companion to [`focus_candidates`], and deliberately not the same
/// measurement. [`sharpness_map`] normalises against the frame's own best, so
/// it can say "here rather than there" within one image and nothing at all
/// about "this crop against that crop" — which is the only question that
/// matters once the candidates have been rendered at their true size. This
/// one is absolute: no normalising, no frame-relative anything.
///
/// The pre-blur is what makes it about focus rather than about grain. At 1:1
/// on a high-ISO frame, sensor noise is the finest detail present by a wide
/// margin, and it is uncorrelated between neighbouring pixels — three pixels
/// of averaging cuts it by about three, while a real edge, which is a
/// consistent step several pixels long, comes through nearly intact.
pub fn resolved_detail(src: &LinearImage) -> f32 {
    let w = src.width as usize;
    let h = src.height as usize;
    if w < 5 || h < 5 {
        return 0.0;
    }
    let log_luma: Vec<f32> = src
        .rgb
        .par_chunks(3)
        .map(|px| (luma(px[0], px[1], px[2]).max(0.0) + 1e-4).ln())
        .collect();
    let smooth = box_blur(&log_luma, w, h, 1);

    let mut energy = vec![0f32; w * h];
    energy.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        if y < 2 || y + 2 >= h {
            return;
        }
        for x in 2..w - 2 {
            let c = smooth[y * w + x];
            let lap = 4.0 * c
                - smooth[y * w + x - 1]
                - smooth[y * w + x + 1]
                - smooth[(y - 1) * w + x]
                - smooth[(y + 1) * w + x];
            row[x] = lap.abs();
        }
    });

    // Weighted by light for the same reason the map is: log luminance makes
    // deep shadow enormously sensitive, and a black patch of grain is not a
    // subject however finely it is resolved.
    let lit = lit_enough(src);
    let weighted: Vec<f32> = energy.into_iter().zip(lit).map(|(e, l)| e * l).collect();
    // A high percentile rather than the mean: a sharp subject on a plain
    // ground is mostly plain ground, and averaging would let a uniformly
    // mediocre patch beat it.
    high_percentile(&weighted, 0.98)
}

/// Composite the focus map over developed pixels, in place.
///
/// The photograph is dimmed and desaturated so the marking reads at a glance,
/// and sharp regions are washed in green with an opacity that follows the
/// score. Soft regions are left dim and grey: the contrast between the two is
/// the message.
pub fn composite_sharpness(img: &mut DecodedImage, map: &[f32]) {
    debug_assert_eq!(map.len(), img.rgba.len() / 4);

    img.rgba
        .par_chunks_mut(4)
        .zip(map.par_iter())
        .for_each(|(px, &score)| {
            let grey = (0.2126 * f32::from(px[0])
                + 0.7152 * f32::from(px[1])
                + 0.0722 * f32::from(px[2]))
                * 0.55;

            // Below this there is no resolved detail worth claiming; leaving
            // it unmarked is more honest than shading noise.
            const FLOOR: f32 = 0.15;
            let strength = ((score - FLOOR) / (1.0 - FLOOR)).clamp(0.0, 1.0);

            let r = grey * (1.0 - strength);
            let g = grey * (1.0 - strength) + 235.0 * strength;
            let b = grey * (1.0 - strength) + 60.0 * strength;
            px[0] = r.clamp(0.0, 255.0) as u8;
            px[1] = g.clamp(0.0, 255.0) as u8;
            px[2] = b.clamp(0.0, 255.0) as u8;
        });
}

/// The exposure that puts this frame where a frame should sit, in stops.
///
/// Measured on scene-linear luminance rather than on the developed histogram,
/// because the developed histogram is a picture of the answer: adjusting
/// exposure from it means chasing a number that moves as you change it. The
/// light that arrived is fixed, so one measurement of it gives one answer.
///
/// The rule is the median to middle grey — the classic reading, and the one
/// that behaves for the ordinary case — with a ceiling that stops it blowing
/// the highlights of a scene whose subject really is dark. A night shot lit by
/// one lamp has a median near black and would otherwise be dragged up several
/// stops until the lamp was a white disc.
///
/// Deliberately only exposure. Contrast, colour and roll-off are what a look
/// is made of, and a preset has already chosen them; brightness is the part
/// that genuinely differs frame to frame.
pub fn auto_exposure(src: &LinearImage) -> f32 {
    /// Above this many stops over middle grey, a highlight is gone.
    const HEADROOM_STOPS: f32 = 2.4;
    /// Percentile treated as "the highlights", high enough to ignore a
    /// specular glint that no exposure choice could have saved.
    const HIGHLIGHT: f32 = 0.995;

    let mut luma: Vec<f32> = src
        .rgb
        .chunks_exact(3)
        .map(|px| luma(px[0], px[1], px[2]))
        .filter(|y| y.is_finite() && *y > 0.0)
        .collect();
    if luma.is_empty() {
        return 0.0;
    }
    luma.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let at = |q: f32| luma[((luma.len() - 1) as f32 * q) as usize];
    let median = at(0.5);
    if median <= 0.0 {
        return 0.0;
    }

    let wanted = (crate::pipeline::MID_GREY / median).log2();
    let highlights = at(HIGHLIGHT);
    let ceiling = if highlights > 0.0 {
        HEADROOM_STOPS - (highlights / crate::pipeline::MID_GREY).log2()
    } else {
        f32::MAX
    };
    wanted.min(ceiling).clamp(-5.0, 5.0)
}

/// Mark every pixel that has run out of range, so the places with no detail
/// left are visible rather than merely dark or bright.
///
/// The two ends are asked differently, on purpose. A *single* channel at 255
/// is a blown highlight worth catching — losing only the red of a red petal
/// leaves it still looking like a petal while it has quietly stopped having
/// any texture, and no later edit brings that back. At the bottom the same
/// rule would fire constantly: a deep blue sky has almost no red in it and is
/// not crushed, it is blue. So shadows are only called clipped when every
/// channel is at zero, which is the point where there is genuinely nothing
/// recorded. [`histogram`] counts the same way, so the marks and the
/// percentages beside them describe the same pixels.
///
/// Marked in flat colour rather than tinted: this is a yes-or-no question, and
/// a wash that varies with the underlying pixel reads as part of the
/// photograph. Red for blown, blue for crushed, the convention every other
/// photo editor uses.
pub fn composite_clipping(img: &mut DecodedImage) {
    img.rgba.par_chunks_mut(4).for_each(|px| {
        let blown = px[0] == 255 || px[1] == 255 || px[2] == 255;
        let crushed = px[0] == 0 && px[1] == 0 && px[2] == 0;
        // Blown wins when a pixel manages both, since a highlight with no
        // detail is the one that cannot be recovered by any later edit.
        if blown {
            px[0] = 235;
            px[1] = 40;
            px[2] = 40;
        } else if crushed {
            px[0] = 40;
            px[1] = 90;
            px[2] = 235;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(pixels: &[[u8; 4]]) -> DecodedImage {
        DecodedImage {
            width: pixels.len() as u32,
            height: 1,
            rgba: pixels.iter().flatten().copied().collect(),
        }
    }

    fn flat_scene(value: f32, pixels: usize) -> LinearImage {
        LinearImage {
            width: pixels as u32,
            height: 1,
            rgb: std::iter::repeat_n(value, pixels * 3).collect(),
        }
    }

    #[test]
    fn auto_exposure_puts_an_ordinary_scene_at_middle_grey() {
        // Two stops under: it should ask for two stops.
        let dim = flat_scene(crate::pipeline::MID_GREY / 4.0, 64);
        assert!((auto_exposure(&dim) - 2.0).abs() < 0.01, "{}", auto_exposure(&dim));

        // Already right: it should ask for nothing.
        let right = flat_scene(crate::pipeline::MID_GREY, 64);
        assert!(auto_exposure(&right).abs() < 0.01);

        // Over: it should come down.
        let bright = flat_scene(crate::pipeline::MID_GREY * 4.0, 64);
        assert!((auto_exposure(&bright) + 2.0).abs() < 0.01);
    }

    #[test]
    fn auto_exposure_does_not_blow_a_scene_that_is_meant_to_be_dark() {
        // A night frame: almost all of it near black, one small bright lamp.
        // Median-to-middle-grey alone would ask for something like six stops
        // and turn the lamp into a white disc.
        let mut rgb: Vec<f32> = std::iter::repeat_n(0.002, 990 * 3).collect();
        rgb.extend(std::iter::repeat_n(0.9, 10 * 3));
        let night = LinearImage { width: 1000, height: 1, rgb };

        let naive = (crate::pipeline::MID_GREY / 0.002f32).log2();
        let chosen = auto_exposure(&night);
        assert!(chosen < naive - 2.0, "held back from {naive:.1}: {chosen:.1}");
        // And the lamp still has somewhere to go afterwards.
        assert!(0.9 * chosen.exp2() < 8.0, "lamp at {}", 0.9 * chosen.exp2());
    }

    #[test]
    fn auto_exposure_survives_a_black_or_empty_frame() {
        assert_eq!(auto_exposure(&flat_scene(0.0, 16)), 0.0);
        assert_eq!(
            auto_exposure(&LinearImage { width: 0, height: 0, rgb: Vec::new() }),
            0.0
        );
    }

    #[test]
    fn the_focus_point_lands_on_the_detailed_part_of_the_frame() {
        // Detail confined to a patch on the left; the rest a flat field. The
        // point that matters is in the patch, not in the middle of the frame.
        let (w, h) = (64usize, 64usize);
        let mut rgb = vec![0.35f32; w * h * 3];
        for y in 20..44 {
            for x in 8..28 {
                let v = if (x + y) % 2 == 0 { 0.6 } else { 0.1 };
                let o = (y * w + x) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
        let (x, y) = focus_point(&LinearImage { width: w as u32, height: h as u32, rgb });
        assert!((0.1..0.45).contains(&x), "x={x}");
        assert!((0.28..0.70).contains(&y), "y={y}");
    }

    #[test]
    fn shadow_noise_does_not_beat_the_lit_subject() {
        // The real failure, from a portrait at ISO 4000: the sharpness score
        // is a ratio, so grain in a near-black floor is an enormous relative
        // modulation and outscored the face. The loupe pointed at a dark
        // rectangle of nothing.
        // A dark, grainy room with one lit textured subject in the left third.
        // No hard division down the middle: the boundary of any patch is a
        // genuine edge and would score highly on its own merits, which would
        // test the frame's construction rather than the rule.
        let (w, h) = (96usize, 96usize);
        let mut rgb = vec![0f32; w * h * 3];
        let lit = |x: usize, y: usize| (16..40).contains(&x) && (36..60).contains(&y);
        for y in 0..h {
            for x in 0..w {
                let v = if lit(x, y) {
                    if (x + y) % 2 == 0 { 0.22 } else { 0.16 }
                } else if (x + y) % 2 == 0 {
                    // Grain at a fifth of its own level: a far larger relative
                    // modulation than the subject's texture.
                    0.0030
                } else {
                    0.0008
                };
                let o = (y * w + x) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
        let src = LinearImage { width: w as u32, height: h as u32, rgb };

        // The premise, measured rather than assumed: away from every edge,
        // the unweighted score really does rate grain above the subject.
        let raw = sharpness_map(&src);
        let subject = raw[48 * w + 28];
        let grain = raw[12 * w + 80];
        assert!(grain >= subject, "premise: grain {grain} scores at least {subject}");

        let (x, y) = focus_point(&src);
        assert!(
            (0.10..0.48).contains(&x) && (0.30..0.68).contains(&y),
            "points at the lit subject, not the grain: ({x}, {y})"
        );
    }

    #[test]
    fn the_centre_bias_settles_ties_without_overruling_a_clear_winner() {
        let w = near_the_middle(101, 101);
        let at = |x: usize, y: usize| w[y * 101 + x];
        assert!((at(50, 50) - 1.0).abs() < 1e-6, "full weight in the middle");
        assert!(at(0, 0) < at(50, 50), "less at a corner");
        // Shallow across the middle: a subject on a thirds line keeps nearly
        // all of its score, which is what stops this overriding real detail.
        assert!(at(33, 50) > 0.94, "thirds line barely touched: {}", at(33, 50));
        // And it is a preference, not a veto.
        assert!(at(0, 0) > 0.5, "a corner is still in the running");
    }

    #[test]
    fn a_detailed_subject_off_centre_still_wins() {
        // The centre bias must not drag the answer to the middle of a frame
        // whose subject is plainly not there.
        let (w, h) = (96usize, 96usize);
        let mut rgb = vec![0.30f32; w * h * 3];
        for y in 8..28 {
            for x in 8..28 {
                let v = if (x + y) % 2 == 0 { 0.42 } else { 0.14 };
                let o = (y * w + x) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
        let (x, y) = focus_point(&LinearImage { width: w as u32, height: h as u32, rgb });
        assert!(x < 0.4 && y < 0.4, "stays on the corner subject: ({x}, {y})");
    }

    /// A patch of textured pixels, optionally softened, optionally grainy.
    ///
    /// `period` is the texture's scale in pixels: 2 is per-pixel, which is
    /// what both a perfectly focused edge and sensor noise look like, and
    /// what makes them so easy to confuse.
    fn patch(edge: usize, level: f32, amplitude: f32, period: usize, blur: bool) -> LinearImage {
        let mut rgb = vec![0f32; edge * edge * 3];
        for y in 0..edge {
            for x in 0..edge {
                let step = (period / 2).max(1);
                let on = (x / step + y / step).is_multiple_of(2);
                let mut v = if on { level + amplitude } else { level - amplitude };
                if blur {
                    // Defocus: the neighbours bleed in, so the modulation
                    // survives at a fraction of its amplitude.
                    v = level + (v - level) * 0.15;
                }
                let o = (y * edge + x) * 3;
                rgb[o] = v.max(0.0);
                rgb[o + 1] = v.max(0.0);
                rgb[o + 2] = v.max(0.0);
            }
        }
        LinearImage { width: edge as u32, height: edge as u32, rgb }
    }

    #[test]
    fn resolved_detail_tells_a_focused_patch_from_a_soft_one() {
        let sharp = resolved_detail(&patch(64, 0.3, 0.12, 2, false));
        let soft = resolved_detail(&patch(64, 0.3, 0.12, 2, true));
        assert!(sharp > soft * 2.0, "sharp {sharp} against soft {soft}");
    }

    #[test]
    fn resolved_detail_is_comparable_between_patches_rather_than_self_relative() {
        // This is the whole reason it exists beside `sharpness_map`. That one
        // normalises against the frame's own best, so a soft patch measured
        // alone scores as highly as a sharp one measured alone — useless for
        // choosing between candidates that were rendered separately.
        let sharp = patch(64, 0.3, 0.12, 2, false);
        let soft = patch(64, 0.3, 0.12, 2, true);
        let peak = |m: Vec<f32>| m.into_iter().fold(0f32, f32::max);
        assert!(
            (peak(sharpness_map(&sharp)) - peak(sharpness_map(&soft))).abs() < 0.01,
            "the normalised map cannot tell these apart, which is the point"
        );
        assert!(resolved_detail(&sharp) > resolved_detail(&soft));
    }

    #[test]
    fn grain_does_not_read_as_focus() {
        // At 1:1 on a high-ISO frame, noise is the finest thing in the picture.
        // A real edge is a consistent step several pixels long; grain flips
        // every pixel, so a little averaging separates them.
        let mut grainy = patch(64, 0.3, 0.10, 2, false);
        // Break the checkerboard's coherence into something noise-like: every
        // pixel independent of the last.
        let mut seed = 12345u32;
        for px in grainy.rgb.chunks_mut(3) {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = 0.3 + if seed >> 31 == 1 { 0.10 } else { -0.10 };
            px[0] = v;
            px[1] = v;
            px[2] = v;
        }
        // A subject with structure: broad bars, the same amplitude.
        let structured = patch(64, 0.3, 0.10, 8, false);
        assert!(
            resolved_detail(&structured) > resolved_detail(&grainy),
            "structure {} should beat grain {}",
            resolved_detail(&structured),
            resolved_detail(&grainy)
        );
    }

    #[test]
    fn candidates_are_different_places_in_the_frame() {
        // Two detailed patches, far apart. Nominating the second-best pixel of
        // the first patch would waste the second look entirely.
        let (w, h) = (128usize, 128usize);
        let mut rgb = vec![0.3f32; w * h * 3];
        let mut textured = |x0: usize, y0: usize| {
            for y in y0..y0 + 20 {
                for x in x0..x0 + 20 {
                    let v = if (x + y) % 2 == 0 { 0.5 } else { 0.12 };
                    let o = (y * w + x) * 3;
                    rgb[o] = v;
                    rgb[o + 1] = v;
                    rgb[o + 2] = v;
                }
            }
        };
        textured(14, 14);
        textured(90, 90);
        let found = focus_candidates(&LinearImage { width: w as u32, height: h as u32, rgb }, 4);
        assert!(found.len() >= 2, "found {found:?}");
        for (i, a) in found.iter().enumerate() {
            for b in found.iter().skip(i + 1) {
                let apart = (a.0 - b.0).abs().max((a.1 - b.1).abs());
                assert!(apart > 0.15, "{a:?} and {b:?} are the same place");
            }
        }
    }

    #[test]
    fn a_frame_with_one_subject_nominates_one_candidate() {
        // Nothing else in the frame has a claim, so there is nothing to
        // compare against and no second render worth paying for.
        let (w, h) = (96usize, 96usize);
        let mut rgb = vec![0.3f32; w * h * 3];
        for y in 40..60 {
            for x in 40..60 {
                let v = if (x + y) % 2 == 0 { 0.55 } else { 0.1 };
                let o = (y * w + x) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
        let found = focus_candidates(&LinearImage { width: w as u32, height: h as u32, rgb }, 5);
        assert_eq!(found.len(), 1, "found {found:?}");
    }

    #[test]
    fn a_frame_with_no_detail_anywhere_gets_the_centre() {
        // A blank wall resolves nothing, and pointing confidently at one
        // corner of it would be inventing an answer.
        let flat = LinearImage { width: 32, height: 32, rgb: vec![0.4; 32 * 32 * 3] };
        assert_eq!(focus_point(&flat), (0.5, 0.5));
        let empty = LinearImage { width: 0, height: 0, rgb: Vec::new() };
        assert_eq!(focus_point(&empty), (0.5, 0.5));
    }

    #[test]
    fn clipping_marks_a_single_blown_channel_but_only_fully_crushed_shadows() {
        let mut img = decoded(&[
            [255, 120, 60, 255],  // red gone: blown, and invisible in the picture
            [40, 0, 90, 255],     // a saturated colour, not a crushed shadow
            [0, 0, 0, 255],       // nothing recorded at all
            [200, 180, 160, 255], // ordinary highlight, left alone
        ]);
        let before = img.rgba.clone();
        composite_clipping(&mut img);
        let px = |i: usize| [img.rgba[i * 4], img.rgba[i * 4 + 1], img.rgba[i * 4 + 2]];

        assert_eq!(px(0), [235, 40, 40], "one blown channel is enough");
        assert_eq!(px(1), before[4..7], "a deep blue is not a crushed shadow");
        assert_eq!(px(2), [40, 90, 235], "black is marked");
        assert_eq!(px(3), before[12..15], "an ordinary pixel is untouched");
    }

    #[test]
    fn the_marks_and_the_reported_percentages_describe_the_same_pixels() {
        // The panel prints these counts beside the image the overlay marks;
        // if they disagreed, one of them would be lying.
        let pixels = [
            [255, 120, 60, 255],
            [40, 0, 90, 255],
            [0, 0, 0, 255],
            [200, 180, 160, 255],
        ];
        let hist = histogram(&decoded(&pixels));
        let mut img = decoded(&pixels);
        composite_clipping(&mut img);
        let marked = |colour: [u8; 3]| {
            img.rgba
                .chunks_exact(4)
                .filter(|px| px[..3] == colour)
                .count() as u32
        };
        assert_eq!(hist.clipped_highlights, marked([235, 40, 40]));
        assert_eq!(hist.clipped_shadows, marked([40, 90, 235]));
    }

    #[test]
    fn histogram_counts_channels_and_clipping() {
        let img = decoded(&[
            [255, 255, 255, 255],
            [0, 0, 0, 255],
            [128, 0, 0, 255],
            [255, 255, 255, 255],
        ]);
        let h = histogram(&img);
        assert_eq!(h.clipped_highlights, 2);
        assert_eq!(h.clipped_shadows, 1);
        assert_eq!(h.red[255], 2);
        assert_eq!(h.red[128], 1);
        assert_eq!(h.luma.iter().sum::<u32>(), 4);
    }

    #[test]
    fn a_partly_blurred_image_scores_higher_where_it_is_detailed() {
        // Left half: alternating pixels (maximum fine detail).
        // Right half: a flat field (no detail at all).
        let (w, h) = (64usize, 32usize);
        let mut rgb = vec![0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 {
                    if (x + y) % 2 == 0 {
                        0.6
                    } else {
                        0.1
                    }
                } else {
                    0.35
                };
                let o = (y * w + x) * 3;
                rgb[o] = v;
                rgb[o + 1] = v;
                rgb[o + 2] = v;
            }
        }
        let src = LinearImage {
            width: w as u32,
            height: h as u32,
            rgb,
        };
        let map = sharpness_map(&src);
        assert_eq!(map.len(), w * h);

        let sample = |x: usize, y: usize| map[y * w + x];
        assert!(sample(16, 16) > 0.5, "detailed side scores high: {}", sample(16, 16));
        assert!(sample(48, 16) < 0.1, "flat side scores low: {}", sample(48, 16));
    }

    #[test]
    fn sharpness_map_is_bounded_and_finite() {
        let (w, h) = (40usize, 40usize);
        let rgb: Vec<f32> = (0..w * h * 3).map(|i| (i % 17) as f32 * 0.3).collect();
        let map = sharpness_map(&LinearImage {
            width: w as u32,
            height: h as u32,
            rgb,
        });
        assert!(map.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
    }

    #[test]
    fn sharpness_map_handles_degenerate_sizes() {
        for (w, h) in [(1u32, 1u32), (2, 2), (1, 40)] {
            let map = sharpness_map(&LinearImage {
                width: w,
                height: h,
                rgb: vec![0.5; (w * h * 3) as usize],
            });
            assert_eq!(map.len(), (w * h) as usize);
        }
    }

    #[test]
    fn a_detail_free_image_does_not_normalise_its_own_noise_up_to_full_scale() {
        let map = sharpness_map(&LinearImage {
            width: 20,
            height: 20,
            rgb: vec![0.4; 20 * 20 * 3],
        });
        let peak = map.iter().copied().fold(0f32, f32::max);
        assert!(peak < 0.01, "flat image resolves no detail, got peak {peak}");
    }

    #[test]
    fn compositing_marks_sharp_areas_green_and_leaves_soft_ones_grey() {
        let mut img = decoded(&[[200, 200, 200, 255], [200, 200, 200, 255]]);
        composite_sharpness(&mut img, &[1.0, 0.0]);

        let sharp = &img.rgba[0..3];
        assert!(sharp[1] > sharp[0] && sharp[1] > sharp[2], "green marking: {sharp:?}");

        let soft = &img.rgba[4..7];
        assert_eq!(soft[0], soft[1], "soft stays neutral: {soft:?}");
        assert_eq!(soft[1], soft[2]);
        assert!(soft[0] < 200, "and dimmed");
    }
}
