//! Automatic straightening: find the straight edges in the picture, then the turn and keystones that
//! make the near-vertical ones plumb and the near-horizontal ones level.
//!
//! Segments come from a line-segment detector in the manner of LSD (von Gioi et al.): pixels whose
//! gradients agree in orientation grow into regions, and elongated, well-filled regions are segments.
//! The fit is robust (Cauchy), so foliage, faces and diagonals cost little; a keystone needs enough
//! agreeing lines to move off zero, so a portrait without architecture is left alone.

use imgvwr_core::LinearImage;
use rayon::prelude::*;
use serde::Serialize;

use crate::crop::{apply, camera_turn};

/// What the turn and keystone sliders should read; zeros when the picture gives no evidence.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Upright {
    pub angle: f32,
    pub vertical: f32,
    pub horizontal: f32,
}

impl Upright {
    pub const NONE: Self = Self {
        angle: 0.0,
        vertical: 0.0,
        horizontal: 0.0,
    };
}

/// A straight edge in a square space centred on the frame, in units of the frame's height.
#[derive(Debug, Clone, Copy)]
pub struct Segment {
    pub a: (f32, f32),
    pub b: (f32, f32),
}

impl Segment {
    fn length(&self) -> f32 {
        (self.b.0 - self.a.0).hypot(self.b.1 - self.a.1)
    }
}

/// Gradient agreement that still grows a region: LSD's 22.5°.
const TOLERANCE: f32 = std::f32::consts::PI / 8.0;

/// Weakest gradient that counts, in display-gamma units per pixel over all three channels; below it the angle is noise.
const MIN_GRADIENT: f32 = 0.02;

/// Shortest piece worth fitting, as a fraction of the frame's longer side; pieces then join into lines.
const MIN_PIECE: f32 = 0.02;

/// Shortest joined line that counts.
const MIN_LENGTH: f32 = 0.05;

/// Pieces of one line stay this close to it, as a fraction of the longer side: a wire's wave, not the next wire.
const JOIN_OFFSET: f32 = 0.004;

/// Largest break along a line that still joins it: a crossing wire, a leaf over a rail.
const JOIN_GAP: f32 = 0.25;

/// Pieces that turn by more than this are different lines.
const JOIN_TURN: f32 = 2.0;

/// Farthest apart two facing edges pair into one centre line, as a fraction of the longer side.
const PAIR_REACH: f32 = 0.3;

/// Share of the longer edge its partner must run alongside.
const PAIR_OVERLAP: f32 = 0.6;

pub fn segments(src: &LinearImage) -> Vec<Segment> {
    let (w, h) = (src.width as usize, src.height as usize);
    if w < 8 || h < 8 {
        return Vec::new();
    }
    // Display gamma, so a dark edge counts like a bright one of the same visible contrast.
    let tone: Vec<f32> = src.rgb.par_iter().map(|v| v.clamp(0.0, 1.0).powf(1.0 / 2.2)).collect();
    let channels: Vec<Vec<f32>> = (0..3)
        .map(|c| {
            let plane: Vec<f32> = tone.iter().skip(c).step_by(3).copied().collect();
            binomial(&plane, w, h)
        })
        .collect();

    // Di Zenzo's colour gradient: a blue rail on green leaves is an edge even where their luma agrees.
    let mut magnitude = vec![0f32; w * h];
    let mut angle = vec![0f32; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (mut jxx, mut jyy, mut jxy) = (0f32, 0f32, 0f32);
            let mut strongest = (0f32, 0f32);
            for plane in &channels {
                let at = |dx: isize, dy: isize| {
                    plane[(y as isize + dy) as usize * w + (x as isize + dx) as usize]
                };
                let gx = (at(1, -1) + 2.0 * at(1, 0) + at(1, 1) - at(-1, -1) - 2.0 * at(-1, 0) - at(-1, 1)) / 8.0;
                let gy = (at(-1, 1) + 2.0 * at(0, 1) + at(1, 1) - at(-1, -1) - 2.0 * at(0, -1) - at(1, -1)) / 8.0;
                jxx += gx * gx;
                jyy += gy * gy;
                jxy += gx * gy;
                if gx.hypot(gy) > strongest.0.hypot(strongest.1) {
                    strongest = (gx, gy);
                }
            }
            let i = y * w + x;
            let spread = ((jxx - jyy) * (jxx - jyy) + 4.0 * jxy * jxy).sqrt();
            magnitude[i] = (0.5 * (jxx + jyy + spread)).sqrt();
            // The tensor gives the gradient's axis; the strongest channel says which way along it, so
            // the two sides of a bar stay two thin segments rather than one hollow region.
            let axis = 0.5 * (2.0 * jxy).atan2(jxx - jyy);
            let (mut gx, mut gy) = (axis.cos(), axis.sin());
            if gx * strongest.0 + gy * strongest.1 < 0.0 {
                (gx, gy) = (-gx, -gy);
            }
            // The level-line direction, as LSD measures it.
            angle[i] = gx.atan2(-gy);
        }
    }

    let mut seeds: Vec<usize> = (0..w * h).filter(|&i| magnitude[i] > MIN_GRADIENT).collect();
    seeds.sort_unstable_by(|&a, &b| magnitude[b].total_cmp(&magnitude[a]));

    let min_length = MIN_PIECE * w.max(h) as f32;
    let mut used = vec![false; w * h];
    let mut out = Vec::new();
    let mut region: Vec<usize> = Vec::new();
    for &seed in &seeds {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        region.clear();
        region.push(seed);
        let (mut sx, mut sy) = (angle[seed].cos(), angle[seed].sin());
        let mut heading = angle[seed];
        let mut k = 0;
        while k < region.len() {
            let (px, py) = ((region[k] % w) as isize, (region[k] / w) as isize);
            k += 1;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (nx, ny) = (px + dx, py + dy);
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        continue;
                    }
                    let n = ny as usize * w + nx as usize;
                    if used[n] || magnitude[n] <= MIN_GRADIENT || angle_gap(angle[n], heading) > TOLERANCE {
                        continue;
                    }
                    used[n] = true;
                    region.push(n);
                    sx += angle[n].cos();
                    sy += angle[n].sin();
                    heading = sy.atan2(sx);
                }
            }
        }
        if let Some((a, b)) = fit(&region, &magnitude, w, min_length) {
            // Pointed along the level line, so the dark side is always on the same hand: the two
            // edges of a bar point opposite ways, which is how `axes` finds them.
            let along = (b.0 - a.0) * heading.cos() + (b.1 - a.1) * heading.sin();
            out.push(if along >= 0.0 { (a, b) } else { (b, a) });
        }
    }

    let reach = w.max(h) as f32;
    let out: Vec<_> = axes(&joined(&out, JOIN_OFFSET * reach, JOIN_GAP * reach), PAIR_REACH * reach)
        .into_iter()
        .filter(|&(a, b)| (b.0 - a.0).hypot(b.1 - a.1) >= MIN_LENGTH * reach)
        .collect();

    // Into the square space centred on the frame, in frame heights.
    let (half_w, half_h, unit) = (w as f32 / 2.0, h as f32 / 2.0, h as f32);
    out.into_iter()
        .map(|((ax, ay), (bx, by))| Segment {
            a: ((ax - half_w) / unit, (ay - half_h) / unit),
            b: ((bx - half_w) / unit, (by - half_h) / unit),
        })
        .collect()
}

type Piece = ((f32, f32), (f32, f32));

/// Pieces lying on one straight line become that line. The eye reads a wavy wire or a rail broken by
/// crossings as one long edge, and its overall direction is what has to be plumb, not each wiggle.
fn joined(pieces: &[Piece], offset: f32, gap: f32) -> Vec<Piece> {
    struct Line {
        ends: Vec<((f32, f32), f32)>,
        centre: (f32, f32),
        dir: (f32, f32),
        /// Which way along the line the pieces point; `dir` is kept agreeing with it.
        sense: (f32, f32),
        lo: f32,
        hi: f32,
    }
    impl Line {
        /// Total least squares through the endpoints, each weighted by its piece's length.
        fn refit(&mut self) {
            let total: f32 = self.ends.iter().map(|e| e.1).sum();
            let cx = self.ends.iter().map(|e| e.0 .0 * e.1).sum::<f32>() / total;
            let cy = self.ends.iter().map(|e| e.0 .1 * e.1).sum::<f32>() / total;
            let (mut sxx, mut syy, mut sxy) = (0f32, 0f32, 0f32);
            for &((x, y), wt) in &self.ends {
                sxx += wt * (x - cx) * (x - cx);
                syy += wt * (y - cy) * (y - cy);
                sxy += wt * (x - cx) * (y - cy);
            }
            let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
            self.centre = (cx, cy);
            self.dir = (theta.cos(), theta.sin());
            if self.dir.0 * self.sense.0 + self.dir.1 * self.sense.1 < 0.0 {
                self.dir = (-self.dir.0, -self.dir.1);
            }
            let along: Vec<f32> = self.ends.iter().map(|e| self.along(e.0)).collect();
            self.lo = along.iter().copied().fold(f32::MAX, f32::min);
            self.hi = along.iter().copied().fold(f32::MIN, f32::max);
        }
        fn along(&self, p: (f32, f32)) -> f32 {
            (p.0 - self.centre.0) * self.dir.0 + (p.1 - self.centre.1) * self.dir.1
        }
        fn point(&self, t: f32) -> (f32, f32) {
            (self.centre.0 + t * self.dir.0, self.centre.1 + t * self.dir.1)
        }
        fn off(&self, p: (f32, f32)) -> f32 {
            (-(p.0 - self.centre.0) * self.dir.1 + (p.1 - self.centre.1) * self.dir.0).abs()
        }
    }

    let mut lines: Vec<Line> = pieces
        .iter()
        .map(|&(a, b)| {
            let length = (b.0 - a.0).hypot(b.1 - a.1);
            let sense = ((b.0 - a.0) / length, (b.1 - a.1) / length);
            let mut line = Line { ends: vec![(a, length / 2.0), (b, length / 2.0)], centre: (0.0, 0.0), dir: sense, sense, lo: 0.0, hi: 0.0 };
            line.refit();
            line
        })
        .collect();
    lines.sort_by(|a, b| (b.hi - b.lo).total_cmp(&(a.hi - a.lo)));

    // Two lines join when one straight line fits both: judged on the joint fit, never by extending a
    // short piece across a gap, where its own wobble would carry it off the other half.
    let mut i = 0;
    while i < lines.len() {
        let mut j = i + 1;
        while j < lines.len() {
            let (l, m) = (&lines[i], &lines[j]);
            // Signed: a bar's two edges are parallel and close, and must stay two lines.
            let turn = (l.dir.0 * m.dir.0 + l.dir.1 * m.dir.1).min(1.0).acos().to_degrees();
            let (ta, tb) = (l.along(m.point(m.lo)), l.along(m.point(m.hi)));
            let apart = (ta.min(tb) - l.hi).max(l.lo - ta.max(tb));
            if turn < JOIN_TURN && apart < gap {
                let mut union = Line { ends: [l.ends.clone(), m.ends.clone()].concat(), centre: l.centre, dir: l.dir, sense: l.sense, lo: 0.0, hi: 0.0 };
                union.refit();
                if union.ends.iter().all(|e| union.off(e.0) < offset) {
                    lines[i] = union;
                    lines.swap_remove(j);
                    // The grown line may now reach lines it was too short for; look again from the start.
                    j = i + 1;
                    continue;
                }
            }
            j += 1;
        }
        i += 1;
    }
    lines.iter().map(|l| (l.point(l.lo), l.point(l.hi))).collect()
}

/// Each pair of facing edges becomes its centre line: a bar's, and the gap's between two bars.
/// Out of focus, light bleeds over a dark edge more where the background is bright, so a blurred post
/// against sky above and cars below looks narrower at the top; both its edges lean, oppositely, while
/// its centre stays true. Sharp, the centre line is just the edges' common direction.
fn axes(lines: &[Piece], reach: f32) -> Vec<Piece> {
    let unit = |&(a, b): &Piece| {
        let l = (b.0 - a.0).hypot(b.1 - a.1);
        ((b.0 - a.0) / l, (b.1 - a.1) / l, l)
    };
    let parallel = JOIN_TURN.to_radians().cos();
    // Signed distance of `p` across line `i` (positive on its right hand), and position along it.
    let across = |i: &Piece, p: (f32, f32)| {
        let (dx, dy, _) = unit(i);
        (-(p.0 - i.0 .0) * dy + (p.1 - i.0 .1) * dx, (p.0 - i.0 .0) * dx + (p.1 - i.0 .1) * dy)
    };
    let mut partner: Vec<[Option<usize>; 2]> = vec![[None, None]; lines.len()];
    for (i, li) in lines.iter().enumerate() {
        let (dx, dy, len_i) = unit(li);
        let mut nearest: [Option<(usize, f32)>; 2] = [None, None];
        for (j, lj) in lines.iter().enumerate() {
            if i == j {
                continue;
            }
            let (ex, ey, len_j) = unit(lj);
            if (dx * ex + dy * ey).abs() < parallel {
                continue;
            }
            let ((sa, ta), (sb, tb)) = (across(li, lj.0), across(li, lj.1));
            let side = (sa + sb) / 2.0;
            let overlap = ta.max(tb).min(len_i) - ta.min(tb).max(0.0);
            // Both edges of one bar run its length; a short scrap beside a long edge is not its partner.
            if side.abs() > reach || overlap < PAIR_OVERLAP * len_i.max(len_j) {
                continue;
            }
            // Any parallel line in between, of either polarity, makes this pair not adjacent.
            let slot = usize::from(side > 0.0);
            if nearest[slot].map_or(true, |(_, d)| side.abs() < d) {
                nearest[slot] = Some((j, side.abs()));
            }
        }
        for slot in 0..2 {
            if let Some((j, _)) = nearest[slot] {
                let (ex, ey, _) = unit(&lines[j]);
                // Facing edges point opposite ways; a same-way neighbour is another bar's same edge.
                if dx * ex + dy * ey < 0.0 {
                    partner[i][slot] = Some(j);
                }
            }
        }
    }

    let mut out = Vec::new();
    let mut paired = vec![false; lines.len()];
    for i in 0..lines.len() {
        for j in partner[i].into_iter().flatten() {
            // Mutual and once: j's nearest on the facing side must be i.
            if j < i || !partner[j].contains(&Some(i)) {
                continue;
            }
            let (li, lj) = (&lines[i], &lines[j]);
            let (dx, dy, len_i) = unit(li);
            let (_, ta) = across(li, lj.0);
            let (_, tb) = across(li, lj.1);
            let (t0, t1) = (ta.min(tb).max(0.0), ta.max(tb).min(len_i));
            let mid = |t: f32| {
                let p = (li.0 .0 + t * dx, li.0 .1 + t * dy);
                let (side, _) = across(lj, p);
                let (ex, ey, _) = unit(lj);
                // `side` is p's distance from lj on lj's right hand; halfway back toward lj.
                (p.0 + side / 2.0 * ey, p.1 - side / 2.0 * ex)
            };
            out.push((mid(t0), mid(t1)));
            paired[i] = true;
            paired[j] = true;
        }
    }
    out.extend(lines.iter().zip(&paired).filter(|(_, &p)| !p).map(|(l, _)| *l));
    out
}

/// A region is a segment when it is long, thin and mostly filled; its axis is the principal one.
fn fit(region: &[usize], magnitude: &[f32], w: usize, min_length: f32) -> Option<((f32, f32), (f32, f32))> {
    if (region.len() as f32) < min_length {
        return None;
    }
    let mut total = 0f64;
    let (mut mx, mut my) = (0f64, 0f64);
    for &i in region {
        let m = magnitude[i] as f64;
        total += m;
        mx += m * ((i % w) as f64 + 0.5);
        my += m * ((i / w) as f64 + 0.5);
    }
    let (mx, my) = (mx / total, my / total);
    let (mut sxx, mut syy, mut sxy) = (0f64, 0f64, 0f64);
    for &i in region {
        let m = magnitude[i] as f64;
        let (dx, dy) = ((i % w) as f64 + 0.5 - mx, (i / w) as f64 + 0.5 - my);
        sxx += m * dx * dx;
        syy += m * dy * dy;
        sxy += m * dx * dy;
    }
    let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let (c, s) = (theta.cos(), theta.sin());
    let (mut lo, mut hi, mut spread) = (f64::MAX, f64::MIN, 0f64);
    for &i in region {
        let (dx, dy) = ((i % w) as f64 + 0.5 - mx, (i / w) as f64 + 0.5 - my);
        let along = dx * c + dy * s;
        let across = -dx * s + dy * c;
        lo = lo.min(along);
        hi = hi.max(along);
        spread += magnitude[i] as f64 * across * across;
    }
    let length = hi - lo + 1.0;
    // Width from the spread, not the extremes: a leaf touching a rail adds a few pixels, not a fatter rail.
    // A curve grown by the tolerance spreads wide for its length and fails here.
    let width = 4.0 * (spread / total).sqrt() + 1.0;
    if length < min_length as f64 || length < 8.0 * width {
        return None;
    }
    Some((
        ((mx + lo * c) as f32, (my + lo * s) as f32),
        ((mx + hi * c) as f32, (my + hi * s) as f32),
    ))
}

fn binomial(src: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut across = src.to_vec();
    for y in 0..h {
        for x in 1..w - 1 {
            let i = y * w + x;
            across[i] = 0.25 * src[i - 1] + 0.5 * src[i] + 0.25 * src[i + 1];
        }
    }
    let mut out = across.clone();
    for y in 1..h - 1 {
        for x in 0..w {
            let i = y * w + x;
            out[i] = 0.25 * across[i - w] + 0.5 * across[i] + 0.25 * across[i + w];
        }
    }
    out
}

fn angle_gap(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(std::f32::consts::TAU);
    d.min(std::f32::consts::TAU - d)
}

/// A segment further than this from both axes is a diagonal and says nothing about level.
const AXIS_REACH: f32 = 25.0;

/// Cauchy scale in degrees: deviations well past it count about the same whatever their size.
const ROBUST: f32 = 0.7;

/// Agreeing lines a keystone needs before it is allowed off zero, as summed squared length in frame
/// heights: half a dozen fence posts, not a hundred stripes of a towel.
const KEYSTONE_EVIDENCE: f32 = 0.5;

/// The same for a turn alone; a single long horizon is enough.
const LEVEL_EVIDENCE: f32 = 0.15;

/// Share of all near-axis lines the answer must agree with; below it a pattern, not the scene, decided.
const AGREEMENT: f32 = 0.3;

/// Convergence is only measurable between lines this far apart, as a fraction of the frame across them.
const KEYSTONE_SPREAD: f32 = 0.3;

#[derive(Clone, Copy, PartialEq)]
enum Axis {
    Vertical,
    Horizontal,
}

struct Line {
    segment: Segment,
    axis: Axis,
    weight: f32,
}

/// The frame's shape and the lens's 35 mm-equivalent focal length: together they say how a turn of the camera moves the lines.
#[derive(Clone, Copy)]
struct Frame {
    aspect: f32,
    focal: f32,
}

/// The turn and keystones (degrees, as the crop stores them) that make the frame's lines plumb and level.
/// `focal` is the 35 mm-equivalent focal length the keystones are measured with.
pub fn upright(src: &LinearImage, focal: f32) -> Upright {
    if src.height == 0 {
        return Upright::NONE;
    }
    let frame = Frame {
        aspect: src.width as f32 / src.height as f32,
        focal,
    };
    let lines: Vec<Line> = segments(src)
        .into_iter()
        .filter_map(|segment| {
            let lean = direction(segment.a, segment.b);
            let axis = if deviation(lean, Axis::Vertical).abs() < AXIS_REACH {
                Axis::Vertical
            } else if deviation(lean, Axis::Horizontal).abs() < AXIS_REACH {
                Axis::Horizontal
            } else {
                return None;
            };
            Some(Line {
                segment,
                axis,
                // Squared: one long edge of a building outweighs many short strokes of texture.
                weight: segment.length() * segment.length(),
            })
        })
        .collect();
    solve(&lines, frame)
}

fn solve(lines: &[Line], frame: Frame) -> Upright {
    // Summed weight of the lines an answer makes plumb or level, and how far apart they lie across their axis.
    let agreeing = |u: &Upright, axis: Axis| -> (f32, f32) {
        let (mut weight, mut lo, mut hi) = (0f32, f32::MAX, f32::MIN);
        for l in lines.iter().filter(|l| l.axis == axis && residual(l, u, frame).abs() < 1.5 * ROBUST) {
            weight += l.weight;
            let (a, b) = (l.segment.a, l.segment.b);
            let across = if axis == Axis::Vertical { (a.0 + b.0) / 2.0 } else { (a.1 + b.1) / 2.0 };
            lo = lo.min(across);
            hi = hi.max(across);
        }
        (weight, (hi - lo).max(0.0))
    };

    let mut free = [true, true, true];
    let mut best = search(lines, frame, free);
    for _ in 0..2 {
        let (vertical, v_spread) = agreeing(&best, Axis::Vertical);
        let (horizontal, h_spread) = agreeing(&best, Axis::Horizontal);
        let plumb = vertical >= KEYSTONE_EVIDENCE && v_spread >= KEYSTONE_SPREAD * frame.aspect;
        // Receding ground (a shore, water, a road) converges too; only a plane that also stands upright is a wall to square.
        let square = plumb && horizontal >= KEYSTONE_EVIDENCE && h_spread >= KEYSTONE_SPREAD;
        let wanted = [true, free[1] && plumb, free[2] && square];
        if wanted == free {
            break;
        }
        free = wanted;
        best = search(lines, frame, free);
    }

    let total: f32 = lines.iter().map(|l| l.weight).sum();
    let agreed = agreeing(&best, Axis::Vertical).0 + agreeing(&best, Axis::Horizontal).0;
    if agreed < LEVEL_EVIDENCE || agreed < AGREEMENT * total {
        return Upright::NONE;
    }
    best
}

/// Coarse grid over turn and vertical keystone, a line search for the horizontal one, then a shrinking pattern search over all three.
fn search(lines: &[Line], frame: Frame, free: [bool; 3]) -> Upright {
    let cost = |u: &Upright| cost(lines, u, frame);
    let span = |on: bool, reach: f32, step: f32| -> Vec<f32> {
        if !on {
            return vec![0.0];
        }
        let n = (reach / step).round() as i32;
        (-n..=n).map(|i| i as f32 * step).collect()
    };
    let grid: Vec<Upright> = span(free[0], 15.0, 0.5)
        .into_iter()
        .flat_map(|angle| {
            span(free[1], 30.0, 1.0).into_iter().map(move |vertical| Upright {
                angle,
                vertical,
                horizontal: 0.0,
            })
        })
        .collect();
    let mut best = grid
        .into_par_iter()
        .map(|u| (cost(&u), u))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, u)| u)
        .unwrap_or(Upright::NONE);
    if free[2] {
        best = span(true, 30.0, 1.0)
            .into_iter()
            .map(|horizontal| Upright { horizontal, ..best })
            .map(|u| (cost(&u), u))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, u)| u)
            .unwrap_or(best);
    }

    let mut current = cost(&best);
    let mut step = 0.5f32;
    while step > 0.01 {
        let mut moved = false;
        for slot in 0..3 {
            if !free[slot] {
                continue;
            }
            for sign in [-1.0, 1.0] {
                let mut probe = best;
                match slot {
                    0 => probe.angle += sign * step,
                    1 => probe.vertical += sign * step,
                    _ => probe.horizontal += sign * step,
                }
                let c = cost(&probe);
                if c < current {
                    (best, current, moved) = (probe, c, true);
                }
            }
        }
        if !moved {
            step /= 2.0;
        }
    }
    best
}

/// No price on the keystone itself: whether to correct is the evidence gate's call in `solve`, and once
/// it says yes, any shrinkage toward zero leaves the lines visibly short of parallel.
fn cost(lines: &[Line], u: &Upright, frame: Frame) -> f32 {
    let turn = camera_turn(u.vertical, u.horizontal, frame.focal, frame.aspect);
    // Each family has the same total say: twenty fence bars must not outvote the two rails on the turn.
    let share = |axis: Axis| -> f32 {
        let total: f32 = lines.iter().filter(|l| l.axis == axis).map(|l| l.weight).sum();
        if total > 0.0 { 1.0 / total } else { 0.0 }
    };
    let (vertical, horizontal) = (share(Axis::Vertical), share(Axis::Horizontal));
    lines
        .iter()
        .map(|l| {
            let d = lean_after(l, &turn, u.angle) / ROBUST;
            let share = if l.axis == Axis::Vertical { vertical } else { horizontal };
            share * l.weight * (1.0 + d * d).ln()
        })
        .sum()
}

/// Degrees the line still leans off its axis once keystoned and turned.
fn residual(line: &Line, u: &Upright, frame: Frame) -> f32 {
    let turn = camera_turn(u.vertical, u.horizontal, frame.focal, frame.aspect);
    lean_after(line, &turn, u.angle)
}

fn lean_after(line: &Line, turn: &[[f64; 3]; 3], angle: f32) -> f32 {
    let warp = |(x, y): (f32, f32)| {
        let (u, v) = apply(turn, x as f64, y as f64);
        (u as f32, v as f32)
    };
    let lean = direction(warp(line.segment.a), warp(line.segment.b)) - angle;
    deviation(lean, line.axis)
}

/// Direction in degrees, clockwise from the x axis (y points down).
fn direction(a: (f32, f32), b: (f32, f32)) -> f32 {
    (b.1 - a.1).atan2(b.0 - a.0).to_degrees()
}

/// Signed degrees from the axis, in (-90, 90]: a segment has no head or tail.
fn deviation(lean: f32, axis: Axis) -> f32 {
    let off = match axis {
        Axis::Horizontal => lean,
        Axis::Vertical => lean - 90.0,
    };
    let d = off.rem_euclid(180.0);
    if d > 90.0 {
        d - 180.0
    } else {
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey field with dark lines drawn through it, anti-aliased by supersampling.
    fn drawing(w: u32, h: u32, lines: &[((f32, f32), (f32, f32))]) -> LinearImage {
        let mut rgb = vec![0.5f32; (w * h * 3) as usize];
        for &((ax, ay), (bx, by)) in lines {
            let steps = ((bx - ax).hypot(by - ay) * 4.0) as usize + 1;
            for k in 0..=steps {
                let t = k as f32 / steps as f32;
                let (x, y) = (ax + (bx - ax) * t, ay + (by - ay) * t);
                for oy in -1..=1 {
                    for ox in -1..=1 {
                        let (px, py) = ((x as i32 + ox), (y as i32 + oy));
                        if px >= 0 && py >= 0 && px < w as i32 && py < h as i32 {
                            let i = (py as u32 * w + px as u32) as usize * 3;
                            rgb[i..i + 3].fill(0.02);
                        }
                    }
                }
            }
        }
        LinearImage { width: w, height: h, rgb }
    }

    #[test]
    fn a_bar_becomes_its_centre_line() {
        // Two edges of a bar 20 px wide, pointing opposite ways as the level lines do, leaning apart.
        let left = ((100.0, 0.0), (98.0, 400.0));
        let right = ((122.0, 400.0), (120.0, 0.0));
        let out = axes(&[left, right], 100.0);
        assert_eq!(out.len(), 1, "{out:?}");
        let (a, b) = out[0];
        let (top, bottom) = if a.1 < b.1 { (a, b) } else { (b, a) };
        assert!((top.0 - 110.0).abs() < 0.5 && (bottom.0 - 110.0).abs() < 0.5, "{out:?}");
    }

    #[test]
    fn a_tilted_horizon_is_found_and_levelled() {
        // Falls to the right by 3°: positive, as the crop's angle is.
        let slope = 3f32.to_radians().tan();
        let lines: Vec<_> = [120.0, 200.0, 280.0]
            .iter()
            .map(|&y| ((20.0, y), (580.0, y + 560.0 * slope)))
            .collect();
        let u = upright(&drawing(600, 400, &lines), 50.0);
        assert!((u.angle - 3.0).abs() < 0.3, "{u:?}");
        assert!(u.vertical.abs() < 1.0 && u.horizontal.abs() < 1.0, "{u:?}");
    }

    #[test]
    fn converging_verticals_are_made_parallel() {
        // Posts leaning in toward the top, as when looking up at a fence: a vanishing point above the frame.
        let (w, h) = (600.0, 400.0);
        let vanish = (300.0, -2000.0);
        let lines: Vec<_> = [60.0, 160.0, 260.0, 340.0, 440.0, 540.0]
            .iter()
            .map(|&x| {
                let t = (380.0 - 20.0) / (380.0 - vanish.1);
                ((x, 380.0), (x + (vanish.0 - x) * t, 20.0))
            })
            .collect();
        let u = upright(&drawing(w as u32, h as u32, &lines), 50.0);
        assert!(u.vertical > 3.0, "{u:?}");
        assert!(u.angle.abs() < 0.5, "{u:?}");
        // Corrected, every post is plumb.
        let rows: Vec<Line> = segments(&drawing(w as u32, h as u32, &lines))
            .into_iter()
            .map(|segment| Line { segment, axis: Axis::Vertical, weight: segment.length() })
            .collect();
        for line in &rows {
            let frame = Frame { aspect: w / h, focal: 50.0 };
            assert!(residual(line, &u, frame).abs() < 0.5, "{}", residual(line, &u, frame));
        }
    }

    #[test]
    fn nothing_straight_means_nothing_changes() {
        let mut rgb = Vec::new();
        for y in 0..300u32 {
            for x in 0..400u32 {
                // Concentric rings: plenty of edges, none of them straight.
                let r = ((x as f32 - 200.0).hypot(y as f32 - 150.0) / 9.0).sin() * 0.4 + 0.5;
                rgb.extend_from_slice(&[r, r, r]);
            }
        }
        let u = upright(&LinearImage { width: 400, height: 300, rgb }, 50.0);
        assert_eq!(u, Upright::NONE);
    }
}
