//! Ward's median-threshold bitmaps: thresholding each frame at its own median is exposure-invariant,
//! so bracket frames stops apart still compare. Every candidate motion is then measured by warping
//! and edge-correlating; a pair that measures poorly is refused rather than merged with a ghost.

use rayon::prelude::*;

/// One grey frame, 8 bits, row-major.
pub struct Gray {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Gray {
    fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }
}

/// Rec. 601; the flavour hardly matters since the bitmap is thresholded at its own median.
pub fn luma_of(rgb: &image::RgbImage) -> Gray {
    let (width, height) = (rgb.width() as usize, rgb.height() as usize);
    let data = rgb
        .pixels()
        .map(|p| ((299 * p.0[0] as u32 + 587 * p.0[1] as u32 + 114 * p.0[2] as u32) / 1000) as u8)
        .collect();
    Gray { width, height, data }
}

fn halved(g: &Gray) -> Gray {
    let width = (g.width / 2).max(1);
    let height = (g.height / 2).max(1);
    let mut data = vec![0u8; width * height];
    data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let sy = (y * 2).min(g.height - 1);
        let sy1 = (sy + 1).min(g.height - 1);
        for (x, out) in row.iter_mut().enumerate() {
            let sx = (x * 2).min(g.width - 1);
            let sx1 = (sx + 1).min(g.width - 1);
            let sum = g.at(sx, sy) as u16
                + g.at(sx1, sy) as u16
                + g.at(sx, sy1) as u16
                + g.at(sx1, sy1) as u16;
            *out = (sum / 4) as u8;
        }
    });
    Gray { width, height, data }
}

/// Over every pixel, clipped included: excluding clipped pixels would move the percentile per-frame and the threshold stops being exposure-invariant.
/// Only when the median itself clips (frame over half blown/black) do clipped pixels sit out, so the threshold still splits what the sensor resolved.
fn median_of(g: &Gray) -> u8 {
    let mut histogram = [0u32; 256];
    for &v in &g.data {
        histogram[v as usize] += 1;
    }
    let median = |counts: &dyn Fn(usize) -> u32, total: u32, fallback: u8| -> u8 {
        if total == 0 {
            return fallback;
        }
        let mut seen = 0u32;
        for value in 0..256 {
            seen += counts(value);
            if seen > total / 2 {
                return value as u8;
            }
        }
        fallback
    };
    let all = median(&|v| histogram[v], g.data.len() as u32, 127);
    if all != 0 && all != 255 {
        return all;
    }
    let resolved =
        |v: usize| if v == 0 || v == 255 { 0 } else { histogram[v] };
    let resolved_total: u32 = histogram[1..255].iter().sum();
    median(&resolved, resolved_total, 127)
}

/// `over`: above the median; `counted`: far enough from it that the vote is the scene's, not noise.
struct Bitmaps {
    width: usize,
    height: usize,
    over: Vec<bool>,
    counted: Vec<bool>,
}

/// Grey levels around the median whose pixels sit out the comparison.
const NOISE_BAND: i16 = 4;

fn bitmaps_of(g: &Gray) -> Bitmaps {
    let median = median_of(g) as i16;
    let over = g.data.iter().map(|&v| (v as i16) > median).collect();
    let counted = g
        .data
        .iter()
        .map(|&v| (v as i16 - median).abs() > NOISE_BAND)
        .collect();
    Bitmaps { width: g.width, height: g.height, over, counted }
}

#[derive(Clone, Copy)]
struct Fit {
    /// Disagreeing fraction of the counted pixels; 0.5 when nothing counted.
    wrong: f64,
    /// Pixels that voted — a perfect score over nothing is not a perfect score.
    counted: u64,
}

/// Compares reference (x, y) against frame (x + dx, y + dy), per counted pixel of the
/// overlap — absolute counts would reward shifts that shrink the overlap.
fn disagreement(reference: &Bitmaps, frame: &Bitmaps, dx: i32, dy: i32) -> Fit {
    let x0 = (-dx).max(0) as usize;
    let y0 = (-dy).max(0) as usize;
    let x1 = (reference.width as i32 - dx.max(0)) as usize;
    let y1 = (reference.height as i32 - dy.max(0)) as usize;
    if x0 >= x1 || y0 >= y1 {
        return Fit { wrong: f64::INFINITY, counted: 0 };
    }
    let (mut wrong, mut counted) = (0u64, 0u64);
    for y in y0..y1 {
        let sy = (y as i32 + dy) as usize;
        let r_row = y * reference.width;
        let f_row = sy * frame.width;
        for x in x0..x1 {
            let sx = (x as i32 + dx) as usize;
            // Counted in either frame, not both: a bright body over flat sky is excluded in the
            // frame whose sky it slid onto, so requiring both sides scores misalignment as agreement.
            if reference.counted[r_row + x] || frame.counted[f_row + sx] {
                counted += 1;
                if reference.over[r_row + x] != frame.over[f_row + sx] {
                    wrong += 1;
                }
            }
        }
    }
    if counted == 0 {
        // No opinion, rather than a perfect score for whatever shift got here first.
        return Fit { wrong: 0.5, counted: 0 };
    }
    Fit { wrong: wrong as f64 / counted as f64, counted }
}

/// How many pyramid levels the search walks, coarsest one ~32 px across.
fn levels_for(width: usize, height: usize) -> usize {
    let mut extent = width.min(height) / 32;
    let mut levels = 0;
    while extent >= 2 && levels < 7 {
        extent /= 2;
        levels += 1;
    }
    levels
}

/// ((dx, dy), wrong fraction, counted), judged at full resolution; the caller decides whether the fit is good enough.
pub fn translation_scored(reference: &Gray, frame: &Gray) -> ((i32, i32), f64, u64) {
    let levels = levels_for(reference.width, reference.height);

    // Both pyramids, coarsest last.
    let mut r_levels = vec![bitmaps_of(reference)];
    let mut f_levels = vec![bitmaps_of(frame)];
    let (mut r, mut f) = (halved(reference), halved(frame));
    for _ in 0..levels {
        r_levels.push(bitmaps_of(&r));
        f_levels.push(bitmaps_of(&f));
        r = halved(&r);
        f = halved(&f);
    }

    let (mut dx, mut dy) = (0i32, 0i32);
    for level in (0..r_levels.len()).rev() {
        if level < r_levels.len() - 1 {
            dx *= 2;
            dy *= 2;
        }
        // ±2 rather than Ward's ±1: doubles the largest shift the walk can reach.
        let candidates: Vec<(i32, i32)> = (dy - 2..=dy + 2)
            .flat_map(|y| (dx - 2..=dx + 2).map(move |x| (x, y)))
            .collect();
        let scored: Vec<Fit> = candidates
            .par_iter()
            .map(|&(x, y)| disagreement(&r_levels[level], &f_levels[level], x, y))
            .collect();
        // 0.98 hysteresis: codec noise alone separates tripod frames, and every pixel of drift
        // crops the merge; a real misalignment beats the incumbent by far more than this margin.
        let mut best = (dx, dy);
        let staying = disagreement(&r_levels[level], &f_levels[level], dx, dy);
        let mut best_score = staying.wrong * 0.98;
        for (&candidate, fit) in candidates.iter().zip(&scored) {
            if fit.wrong < best_score {
                best_score = fit.wrong;
                best = candidate;
            }
        }
        (dx, dy) = best;
    }
    let judged = disagreement(&r_levels[0], &f_levels[0], dx, dy);
    ((dx, dy), judged.wrong, judged.counted)
}

/// Maps reference coordinates onto frame coordinates: the frame shows at `R·p + t` what the reference shows at `p`.
#[derive(Clone, Copy, Debug)]
pub struct Rigid {
    pub cos: f64,
    pub sin: f64,
    pub tx: f64,
    pub ty: f64,
}

impl Rigid {
    pub const IDENTITY: Rigid = Rigid { cos: 1.0, sin: 0.0, tx: 0.0, ty: 0.0 };

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.cos * x - self.sin * y + self.tx,
            self.sin * x + self.cos * y + self.ty,
        )
    }

    /// The motion "first `inner`, then this".
    pub fn after(&self, inner: &Rigid) -> Rigid {
        Rigid {
            cos: self.cos * inner.cos - self.sin * inner.sin,
            sin: self.sin * inner.cos + self.cos * inner.sin,
            tx: self.cos * inner.tx - self.sin * inner.ty + self.tx,
            ty: self.sin * inner.tx + self.cos * inner.ty + self.ty,
        }
    }

    pub fn inverse(&self) -> Rigid {
        Rigid {
            cos: self.cos,
            sin: -self.sin,
            tx: -(self.cos * self.tx + self.sin * self.ty),
            ty: -(-self.sin * self.tx + self.cos * self.ty),
        }
    }

    pub fn degrees(&self) -> f64 {
        self.sin.atan2(self.cos).to_degrees()
    }
}

/// A vote that "won" with a third of its pixels disagreeing is the least bad of bad guesses, not an alignment.
const TILE_MAX_WRONG: f64 = 0.30;

/// A vote must rest on at least this fraction of the tile's pixels; flat sky with three votes has no opinion.
const TILE_MIN_COUNTED: f64 = 0.002;

/// Tiles per axis: nine votes is enough to fit a rotation and still drop the liars.
const TILES: usize = 3;

/// Brackets are shot in a breath; a "rotation" past a couple of degrees is a bad fit, not a camera move.
const MAX_ROTATION_DEG: f64 = 2.0;

/// Surviving tiles must agree with the fit within this many pixels — pixel-perfect or refuse.
const MAX_RESIDUAL_PX: f64 = 4.0;

/// The rigid motion of `frame` relative to `reference`, fitted from per-tile votes — or a refusal:
/// a merge built on "probably" gets a second sun.
pub fn rigid_between(reference: &Gray, frame: &Gray) -> Result<Rigid, String> {
    let tile_w = reference.width / TILES;
    let tile_h = reference.height / TILES;
    if tile_w < 64 || tile_h < 64 {
        // Too small to tile: a single global translation is the best available.
        let ((dx, dy), wrong, _) = translation_scored(reference, frame);
        if wrong > TILE_MAX_WRONG {
            return Err("the frames do not match well enough to align".to_string());
        }
        return Ok(Rigid { cos: 1.0, sin: 0.0, tx: dx as f64, ty: dy as f64 });
    }

    let tile_of = |g: &Gray, tx: usize, ty: usize| -> Gray {
        let mut data = Vec::with_capacity(tile_w * tile_h);
        for y in 0..tile_h {
            let row = (ty * tile_h + y) * g.width + tx * tile_w;
            data.extend_from_slice(&g.data[row..row + tile_w]);
        }
        Gray { width: tile_w, height: tile_h, data }
    };

    let cells: Vec<(usize, usize)> =
        (0..TILES).flat_map(|ty| (0..TILES).map(move |tx| (tx, ty))).collect();
    let votes: Vec<Option<Vote>> = cells
        .par_iter()
        .map(|&(tx, ty)| {
            let r = tile_of(reference, tx, ty);
            let f = tile_of(frame, tx, ty);
            let ((dx, dy), wrong, counted) = translation_scored(&r, &f);
            let evidence = counted as f64 / (tile_w * tile_h) as f64;
            // Texture-weighted: smooth sky scores its own iso-line beautifully wherever it slides —
            // an excellent score around no answer — so one tile holding the subject must outvote it.
            let texture = edge_fraction(&r).min(edge_fraction(&f));
            let weight = counted as f64 * texture;
            if std::env::var_os("HDR_DEBUG").is_some() {
                eprintln!(
                    "  tile ({tx},{ty}): shift ({dx:+}, {dy:+}) wrong {wrong:.3} evidence {evidence:.4} texture {texture:.4}"
                );
            }
            if wrong > TILE_MAX_WRONG || evidence < TILE_MIN_COUNTED || weight <= 0.0 {
                return None;
            }
            // (at, seen): the tile centre in frame-global coordinates, and where the frame shows it.
            let cx = (tx * tile_w + tile_w / 2) as f64;
            let cy = (ty * tile_h + tile_h / 2) as f64;
            Some(Vote {
                at: (cx, cy),
                seen: (cx + dx as f64, cy + dy as f64),
                weight,
            })
        })
        .collect();
    let initial: Vec<Vote> = votes.into_iter().flatten().collect();
    if initial.is_empty() {
        return Err("no region of these frames matches well enough to align".to_string());
    }
    let mut points: Vec<Vote> = initial.clone();

    // Candidates: the rigid consensus where one converges, plus each cluster of tile slides as a
    // plain translation. None is trusted — each is measured by warping and edge-correlating, and
    // nothing measuring well enough is a refusal.
    let mut candidates: Vec<Rigid> = Vec::new();

    let residual = |t: &Rigid, p: &Vote| -> f64 {
        let q = t.apply(p.at.0, p.at.1);
        ((q.0 - p.seen.0).powi(2) + (q.1 - p.seen.1).powi(2)).sqrt()
    };
    while points.len() >= 3 {
        let fitted = fit_rigid(&points);
        let residuals: Vec<f64> = points.iter().map(|p| residual(&fitted, p)).collect();
        let (worst_at, worst) = residuals
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .expect("nonempty");
        if *worst <= MAX_RESIDUAL_PX {
            if fitted.degrees().abs() <= MAX_ROTATION_DEG {
                candidates.push(fitted);
            }
            break;
        }
        points.remove(worst_at);
    }

    let slide_of = |v: &Vote| (v.seen.0 - v.at.0, v.seen.1 - v.at.1);
    let mut by_weight: Vec<&Vote> = initial.iter().collect();
    by_weight.sort_by(|a, b| b.weight.total_cmp(&a.weight));
    for vote in by_weight {
        let (dx, dy) = slide_of(vote);
        let seen = candidates.iter().any(|c| {
            ((c.tx - dx).powi(2) + (c.ty - dy).powi(2)).sqrt() <= CLUSTER_PX && c.sin.abs() < 1e-4
        });
        if !seen && candidates.len() < 8 {
            candidates.push(Rigid { cos: 1.0, sin: 0.0, tx: dx, ty: dy });
        }
    }

    let quarter_ref = quarter_luma(reference);
    let quarter_frame = quarter_luma(frame);
    let scored = candidates
        .par_iter()
        .map(|candidate| {
            let shrunk = Rigid {
                cos: candidate.cos,
                sin: candidate.sin,
                tx: candidate.tx / 4.0,
                ty: candidate.ty / 4.0,
            };
            edge_agreement(&quarter_ref, &warped_luma(&quarter_frame, &shrunk))
        })
        .collect::<Vec<f64>>();
    let (best_at, best) = scored
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .ok_or_else(|| "the frames do not align: nothing to measure".to_string())?;
    if std::env::var_os("HDR_DEBUG").is_some() {
        for (candidate, score) in candidates.iter().zip(&scored) {
            eprintln!(
                "  candidate ({:+.1}, {:+.1}, {:+.2}°): agreement {score:.3}",
                candidate.tx,
                candidate.ty,
                candidate.degrees()
            );
        }
    }
    if *best < MIN_EDGE_AGREEMENT {
        return Err(format!(
            "the frames do not align: the best candidate only agrees {best:.2}"
        ));
    }
    Ok(candidates[best_at])
}

#[derive(Clone)]
struct Vote {
    at: (f64, f64),
    seen: (f64, f64),
    weight: f64,
}

/// How far apart two tiles' slides may be and still be one opinion.
const CLUSTER_PX: f64 = 6.0;

/// Aligned real frames measure 0.3 and up; misaligned ones a tenth of that.
pub(crate) const MIN_EDGE_AGREEMENT: f64 = 0.2;

/// 4× box-down: cheap enough to score eight candidates in milliseconds, sharp enough that a few pixels of misalignment still kill the correlation.
fn quarter_luma(g: &Gray) -> Vec<Vec<f32>> {
    let (w, h) = (g.width / 4, g.height / 4);
    (0..h)
        .into_par_iter()
        .map(|y| {
            (0..w)
                .map(|x| {
                    let mut sum = 0u32;
                    for oy in 0..4 {
                        for ox in 0..4 {
                            sum += g.at(x * 4 + ox, y * 4 + oy) as u32;
                        }
                    }
                    sum as f32 / 16.0
                })
                .collect()
        })
        .collect()
}

/// The luma grid resampled under a motion, bilinear, edges clamped.
fn warped_luma(src: &[Vec<f32>], motion: &Rigid) -> Vec<Vec<f32>> {
    let h = src.len();
    let w = src.first().map_or(0, |r| r.len());
    if w == 0 || h == 0 {
        return Vec::new();
    }
    (0..h)
        .into_par_iter()
        .map(|y| {
            (0..w)
                .map(|x| {
                    let (fx, fy) = motion.apply(x as f64, y as f64);
                    let x0 = (fx.floor() as i64).clamp(0, w as i64 - 1) as usize;
                    let y0 = (fy.floor() as i64).clamp(0, h as i64 - 1) as usize;
                    let x1 = (x0 + 1).min(w - 1);
                    let y1 = (y0 + 1).min(h - 1);
                    let (ax, ay) = ((fx - x0 as f64) as f32, (fy - y0 as f64) as f32);
                    let (ax, ay) = (ax.clamp(0.0, 1.0), ay.clamp(0.0, 1.0));
                    let top = src[y0][x0] * (1.0 - ax) + src[y0][x1] * ax;
                    let bottom = src[y1][x0] * (1.0 - ax) + src[y1][x1] * ax;
                    top * (1.0 - ay) + bottom * ay
                })
                .collect()
        })
        .collect()
}

/// Pearson correlation of edge magnitudes, restricted to pixels where the reference has a real edge and both frames resolved the scene — whole-frame scoring drowns in flat-sky noise.
/// Correlation, not difference: the frames are stops apart, and only edge placement defines aligned.
pub(crate) fn edge_agreement(a: &[Vec<f32>], b: &[Vec<f32>]) -> f64 {
    /// A real boundary in downsampled luma, above JPEG ripple on flat sky.
    const REFERENCE_EDGE: f64 = 4.0;
    let h = a.len().min(b.len());
    if h < 2 {
        return 0.0;
    }
    let w = a[0].len().min(b[0].len());
    if w < 2 {
        return 0.0;
    }
    let (mut n, mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0, 0.0, 0.0, 0.0, 0.0);
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let (va, vb) = (a[y][x], b[y][x]);
            if !(10.0..=245.0).contains(&va) || !(10.0..=245.0).contains(&vb) {
                continue;
            }
            let ea = ((a[y][x + 1] - va).abs() + (a[y + 1][x] - va).abs()) as f64;
            if ea < REFERENCE_EDGE {
                continue;
            }
            let eb = ((b[y][x + 1] - vb).abs() + (b[y + 1][x] - vb).abs()) as f64;
            n += 1.0;
            sa += ea;
            sb += eb;
            saa += ea * ea;
            sbb += eb * eb;
            sab += ea * eb;
        }
    }
    // Too little shared ground to judge; the floor scales with the frame so a stray speckle never satisfies it.
    let floor = (((w * h) as f64) / 1024.0).max(64.0);
    if n < floor {
        return 0.0;
    }
    let cov = sab / n - (sa / n) * (sb / n);
    let var_a = saa / n - (sa / n) * (sa / n);
    let var_b = sbb / n - (sb / n) * (sb / n);
    if var_a <= 0.0 || var_b <= 0.0 {
        return 0.0;
    }
    cov / (var_a * var_b).sqrt()
}

/// Above the ripple JPEG leaves on flat sky, below any real boundary.
const EDGE_STEP: i16 = 16;

fn edge_fraction(g: &Gray) -> f64 {
    if g.width < 2 || g.height < 2 {
        return 0.0;
    }
    let edges: u64 = (0..g.height - 1)
        .into_par_iter()
        .map(|y| {
            let mut row_edges = 0u64;
            for x in 0..g.width - 1 {
                let here = g.at(x, y) as i16;
                let right = g.at(x + 1, y) as i16;
                let down = g.at(x, y + 1) as i16;
                if (here - right).abs() > EDGE_STEP || (here - down).abs() > EDGE_STEP {
                    row_edges += 1;
                }
            }
            row_edges
        })
        .sum();
    edges as f64 / ((g.width - 1) * (g.height - 1)) as f64
}

/// Weighted least-squares rigid motion through matched points (2-D Kabsch).
fn fit_rigid(points: &[Vote]) -> Rigid {
    let total: f64 = points.iter().map(|v| v.weight).sum::<f64>().max(1e-9);
    let (mut cx, mut cy, mut qx, mut qy) = (0.0, 0.0, 0.0, 0.0);
    for v in points {
        cx += v.at.0 * v.weight;
        cy += v.at.1 * v.weight;
        qx += v.seen.0 * v.weight;
        qy += v.seen.1 * v.weight;
    }
    (cx, cy, qx, qy) = (cx / total, cy / total, qx / total, qy / total);
    let (mut dot, mut cross) = (0.0, 0.0);
    for v in points {
        let (ax, ay) = (v.at.0 - cx, v.at.1 - cy);
        let (bx, by) = (v.seen.0 - qx, v.seen.1 - qy);
        dot += (ax * bx + ay * by) * v.weight;
        cross += (ax * by - ay * bx) * v.weight;
    }
    let theta = cross.atan2(dot);
    let (sin, cos) = theta.sin_cos();
    Rigid {
        cos,
        sin,
        tx: qx - (cos * cx - sin * cy),
        ty: qy - (sin * cx + cos * cy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The texture is load-bearing: a pure smooth ramp is thresholded at a different iso-line by every exposure, and no median bitmap can align that.
    fn scene(width: usize, height: usize) -> Gray {
        let mut data = vec![0u8; width * height];
        for y in 0..height {
            for x in 0..width {
                let gradient = (x * 96 / width + y * 64 / height) as i32;
                let dx = x as i32 - (width as i32 / 3);
                let dy = y as i32 - (height as i32 / 2);
                let disk = if dx * dx + dy * dy < (width as i32 / 6).pow(2) { 140 } else { 0 };
                // Deterministic clutter at three scales, so coarse pyramid levels see structure too.
                let noise = |gx: usize, gy: usize, salt: usize| -> i32 {
                    (gx.wrapping_mul(2654435761) ^ gy.wrapping_mul(40503) ^ salt.wrapping_mul(97))
                        as i32
                        % 61
                        - 30
                };
                let texture = noise(x / 48, y / 48, 1) + noise(x / 12, y / 12, 2) + noise(x, y, 3);
                data[y * width + x] = (gradient + disk + texture).clamp(0, 255) as u8;
            }
        }
        Gray { width, height, data }
    }

    /// Slid by (dx, dy) and re-exposed by `gain` per mille, so the frames share structure but no grey level.
    fn shifted(source: &Gray, dx: i32, dy: i32, gain: u32) -> Gray {
        let mut data = vec![0u8; source.width * source.height];
        for y in 0..source.height {
            for x in 0..source.width {
                let sx = (x as i32 - dx).clamp(0, source.width as i32 - 1) as usize;
                let sy = (y as i32 - dy).clamp(0, source.height as i32 - 1) as usize;
                let exposed = source.at(sx, sy) as u32 * gain / 1000;
                data[y * source.width + x] = exposed.min(255) as u8;
            }
        }
        Gray { width: source.width, height: source.height, data }
    }

    #[test]
    fn a_known_shift_is_recovered_across_an_exposure_change() {
        let reference = scene(640, 480);
        for (dx, dy, gain) in [(14, -9, 2500), (-21, 6, 400), (0, 0, 1000)] {
            let frame = shifted(&reference, dx, dy, gain);
            let (found_x, found_y) = translation_scored(&reference, &frame).0;
            // The finest level sits out the search, so ±2 px is exact enough.
            assert!(
                (found_x - dx).abs() <= 2 && (found_y - dy).abs() <= 2,
                "asked ({dx}, {dy}), found ({found_x}, {found_y}) at gain {gain}"
            );
        }
    }

    #[test]
    fn an_eclipse_survives_its_own_bracket() {
        // Nearly flat dark sky, one small bright body, exposures 1/8000 to 1/125: alignment has only the disk to hold on to.
        let (width, height) = (640, 480);
        let mut sky = vec![6u8; width * height];
        for y in 0..height {
            for x in 0..width {
                let dx = x as i32 - 300;
                let dy = y as i32 - 220;
                if dx * dx + dy * dy < 40 * 40 {
                    sky[y * width + x] = 180;
                }
            }
        }
        let dark = Gray { width, height, data: sky };
        let long_exposure = shifted(&dark, -17, 11, 8000);
        let (dx, dy) = translation_scored(&dark, &long_exposure).0;
        assert!(
            (dx + 17).abs() <= 2 && (dy - 11).abs() <= 2,
            "asked (-17, 11), found ({dx}, {dy})"
        );
    }

    #[test]
    fn a_frame_of_nothing_reports_no_shift() {
        // Flat grey abstains from every comparison; the walk must keep (0, 0) rather than drift.
        let flat = Gray { width: 320, height: 240, data: vec![128; 320 * 240] };
        assert_eq!(translation_scored(&flat, &flat).0, (0, 0));
    }

    #[test]
    fn the_median_splits_a_histogram_in_the_middle() {
        let g = Gray { width: 4, height: 1, data: vec![10, 20, 30, 200] };
        assert_eq!(median_of(&g), 30);
    }
}
