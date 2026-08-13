//! Merging an exposure bracket into one photograph.
//!
//! The caller hands over decoded frames of the same scene at different
//! exposures; this crate lines them up, crops to the pixels every frame
//! actually saw, and fuses. What comes back is an ordinary 8-bit picture —
//! see `fuse` for why fusion rather than a radiance map, and `align` for
//! why median threshold bitmaps and why alignment is a rigid motion rather
//! than a slide.
//!
//! Alignment is verified, and a merge that cannot be aligned is *refused*.
//! Nine regions of every frame vote independently; a rigid motion has to
//! explain the surviving votes to within a few pixels or there is no merge.
//! The failure mode this buys out of is the worst one this module has: a
//! plausible-looking fusion with a second sun in it.
//!
//! No files and no formats: decoding, encoding and metadata belong to the
//! caller, which is the layer that knows what the bytes were.

mod align;
mod fuse;

pub use align::Rigid;

use rayon::prelude::*;

/// What a merge produced, and what it did to get there.
pub struct Merged {
    pub image: image::RgbImage,
    /// Which input frame the others were aligned to: the middle of the run
    /// of exposures that verifiably aligned — chosen by measurement, not
    /// position, so one unalignable frame never dictates the outcome.
    pub reference: usize,
    /// Per input frame, the motion that was undone to lay it on the
    /// reference (mapping reference coordinates onto that frame's) — None
    /// for a frame that could not be aligned and was left out.
    pub motions: Vec<Option<Rigid>>,
}

/// The overlap a merge refuses to go below: frames sharing less than this
/// fraction of their extent per axis are different pictures, not a bracket.
const MIN_OVERLAP: f64 = 0.75;

pub fn merge(frames: &[image::RgbImage]) -> Result<Merged, String> {
    if frames.len() < 2 {
        return Err("a merge needs at least two frames".to_string());
    }
    let (width, height) = (frames[0].width() as usize, frames[0].height() as usize);
    if frames.iter().any(|f| (f.width() as usize, f.height() as usize) != (width, height)) {
        return Err("the frames are not the same size".to_string());
    }

    // Alignment walks the bracket in brightness order, each frame against
    // its exposure neighbour. Never directly across the bracket: its ends
    // are six stops apart, and six stops of clipping leave two thresholded
    // frames barely showing the same picture — neighbours are one bracket
    // step apart by construction.
    let grays: Vec<align::Gray> = frames.par_iter().map(align::luma_of).collect();
    let mut order: Vec<usize> = (0..frames.len()).collect();
    let mean = |g: &align::Gray| -> u64 {
        g.data.iter().map(|&v| v as u64).sum::<u64>() / g.data.len().max(1) as u64
    };
    order.sort_by_key(|&i| mean(&grays[i]));

    let links: Vec<Result<Rigid, String>> = (0..frames.len() - 1)
        .into_par_iter()
        .map(|k| align::rigid_between(&grays[order[k]], &grays[order[k + 1]]))
        .collect();

    // Failed links split the ordered bracket into runs of frames that
    // verifiably continue one another, and the merge takes the longest run.
    // The anchor is an *outcome* of the measurements, never a prior: a
    // bracket whose middle frame is the unalignable one (a bird, a cloud,
    // parallax at the wrong moment) still merges the frames that do agree,
    // instead of the middle's failure sinking everything. Ties prefer the
    // run holding the middle exposure — its metadata is the honest one to
    // hand a viewer — and the reference is the chosen run's own middle, so
    // composed errors stay half a run long at worst.
    let mut runs: Vec<std::ops::Range<usize>> = Vec::new();
    let mut start = 0;
    for (k, link) in links.iter().enumerate() {
        if link.is_err() {
            runs.push(start..k + 1);
            start = k + 1;
        }
    }
    runs.push(start..frames.len());
    let middle = frames.len() / 2;
    let run = runs
        .iter()
        .max_by_key(|r| (r.len(), r.contains(&middle)))
        .cloned()
        .expect("a bracket always has at least one run");
    if run.len() < 2 {
        let refusal = links
            .iter()
            .find_map(|l| l.as_ref().err())
            .cloned()
            .unwrap_or_else(|| "the frames do not align".to_string());
        return Err(refusal);
    }

    // A link that cannot be aligned does not sink the bracket: the frames
    // beyond the run are left out and the rest still merge. Align or
    // refuse holds per frame — an excluded frame contributes nothing,
    // which is strictly better than contributing a ghost.
    let run_middle = run.start + run.len() / 2;
    let reference = order[run_middle];
    let mut motions: Vec<Option<Rigid>> = vec![None; frames.len()];
    motions[reference] = Some(Rigid::IDENTITY);
    for k in run_middle + 1..run.end {
        let previous = motions[order[k - 1]].expect("walked outward in order");
        let link = links[k - 1].as_ref().expect("a run never crosses a failed link");
        motions[order[k]] = Some(link.after(&previous));
    }
    for k in (run.start..run_middle).rev() {
        let next = motions[order[k + 1]].expect("walked outward in order");
        let link = links[k].as_ref().expect("a run never crosses a failed link");
        motions[order[k]] = Some(link.inverse().after(&next));
    }
    let included: Vec<usize> = (0..frames.len()).filter(|&i| motions[i].is_some()).collect();

    // The window every motioned frame covers. Cropping to it is the honest
    // move: pixels only one end of the bracket saw would have to be
    // invented for the others, and an edge of invented pixels is what
    // merges are remembered by. Iterative, because shrinking a corner of a
    // rotated rectangle moves where the other corners land.
    let (mut x0, mut y0) = (0.0f64, 0.0f64);
    let (mut x1, mut y1) = (width as f64 - 1.0, height as f64 - 1.0);
    // Samples may land exactly on [0, w−1]: the bilinear clamp makes the
    // very edge exact, so identity motions cost no pixels at all.
    for _ in 0..6 {
        for motion in motions.iter().flatten() {
            for (cx, cy) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
                let (qx, qy) = motion.apply(cx, cy);
                if qx < 0.0 {
                    if cx == x0 { x0 -= qx } else { x1 += qx }
                }
                if qx > width as f64 - 1.0 {
                    let push = qx - (width as f64 - 1.0);
                    if cx == x1 { x1 -= push } else { x0 += push }
                }
                if qy < 0.0 {
                    if cy == y0 { y0 -= qy } else { y1 += qy }
                }
                if qy > height as f64 - 1.0 {
                    let push = qy - (height as f64 - 1.0);
                    if cy == y1 { y1 -= push } else { y0 += push }
                }
            }
        }
    }
    let (ox, oy) = (x0.ceil(), y0.ceil());
    let out_w = (x1.floor() - ox + 1.0) as i64;
    let out_h = (y1.floor() - oy + 1.0) as i64;
    if (out_w as f64) < width as f64 * MIN_OVERLAP || (out_h as f64) < height as f64 * MIN_OVERLAP {
        return Err("the frames do not overlap enough to be one scene".to_string());
    }
    let (out_w, out_h) = (out_w as u32, out_h as u32);

    let mut aligned: Vec<(usize, image::RgbImage)> = included
        .par_iter()
        .map(|&i| {
            let motion = motions[i].expect("included frames have motions");
            (i, warped(&frames[i], &motion, ox, oy, out_w, out_h))
        })
        .collect();

    // The last word is photometric, because it is the only word that
    // actually measures ghosting: after warping, every frame's edges must
    // land on the reference's edges wherever both frames saw the scene. A
    // chain of pairwise alignments can carry one confident lie a long way;
    // this check does not care which link lied, only whether the frame in
    // hand is the same picture. A frame that fails is left out.
    let reference_at = included
        .iter()
        .position(|&i| i == reference)
        .expect("the reference is always included");
    let reference_luma = half_luma(&aligned[reference_at].1);
    let agreements: Vec<f64> = aligned
        .par_iter()
        .map(|(i, image)| {
            if *i == reference {
                return 1.0;
            }
            align::edge_agreement(&reference_luma, &half_luma(image))
        })
        .collect();
    if std::env::var_os("HDR_DEBUG").is_some() {
        for ((i, _), corr) in aligned.iter().zip(&agreements) {
            eprintln!("  frame {i}: edge agreement {corr:.3}");
        }
    }
    for (at, corr) in agreements.iter().enumerate().rev() {
        if *corr < align::MIN_EDGE_AGREEMENT {
            motions[aligned[at].0] = None;
            aligned.remove(at);
        }
    }
    if aligned.len() < 2 {
        return Err("the frames do not align: the aligned frames do not show one picture".to_string());
    }

    let fusible: Vec<image::RgbImage> = aligned.into_iter().map(|(_, image)| image).collect();
    Ok(Merged { image: fuse::exposure_fusion(&fusible), reference, motions })
}

/// The frame resampled into reference coordinates: output (x, y) reads the
/// frame at `motion(x + ox, y + oy)`, bilinear. The crop guarantees every
/// sample lands inside; the clamp is a seatbelt, not a strategy.
fn warped(
    frame: &image::RgbImage,
    motion: &Rigid,
    ox: f64,
    oy: f64,
    out_w: u32,
    out_h: u32,
) -> image::RgbImage {
    let (w, h) = (frame.width() as i64, frame.height() as i64);
    let mut out = image::RgbImage::new(out_w, out_h);
    out.par_chunks_mut(out_w as usize * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..out_w as usize {
                let (fx, fy) = motion.apply(x as f64 + ox, y as f64 + oy);
                let x0 = (fx.floor() as i64).clamp(0, w - 1);
                let y0 = (fy.floor() as i64).clamp(0, h - 1);
                let x1 = (x0 + 1).min(w - 1);
                let y1 = (y0 + 1).min(h - 1);
                let (ax, ay) = (fx - x0 as f64, fy - y0 as f64);
                let at = |px: i64, py: i64| frame.get_pixel(px as u32, py as u32).0;
                let (p00, p10, p01, p11) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
                for c in 0..3 {
                    let top = p00[c] as f64 * (1.0 - ax) + p10[c] as f64 * ax;
                    let bottom = p01[c] as f64 * (1.0 - ax) + p11[c] as f64 * ax;
                    row[x * 3 + c] = (top * (1.0 - ay) + bottom * ay).round() as u8;
                }
            }
        });
    out
}

/// Luma at half resolution — where a few pixels of misalignment are still
/// visible to the check but noise mostly is not.
fn half_luma(rgb: &image::RgbImage) -> Vec<Vec<f32>> {
    let (w, h) = ((rgb.width() / 2) as usize, (rgb.height() / 2) as usize);
    (0..h)
        .into_par_iter()
        .map(|y| {
            (0..w)
                .map(|x| {
                    let mut sum = 0.0f32;
                    for (ox, oy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let p = rgb.get_pixel((x * 2 + ox) as u32, (y * 2 + oy) as u32).0;
                        sum += 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
                    }
                    sum / 4.0
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A photograph-shaped scene: a warm disk over textured ground. The
    /// texture is multi-scale on purpose — a smooth synthetic ramp is the
    /// one thing exposure-invariant alignment cannot hold on to, and no
    /// photograph is one.
    fn scene(width: u32, height: u32) -> image::RgbImage {
        let noise = |gx: u32, gy: u32, salt: u32| -> i32 {
            (gx.wrapping_mul(2654435761) ^ gy.wrapping_mul(40503) ^ salt.wrapping_mul(97)) as i32
                % 61
                - 30
        };
        image::RgbImage::from_fn(width, height, |x, y| {
            let dx = x as i32 - width as i32 / 3;
            let dy = y as i32 - height as i32 / 2;
            if dx * dx + dy * dy < (width as i32 / 6).pow(2) {
                return image::Rgb([230, 120, 60]);
            }
            let ground = 90 + noise(x / 24, y / 24, 1) + noise(x / 6, y / 6, 2) + noise(x, y, 3);
            let v = ground.clamp(0, 255) as u8;
            image::Rgb([v, v, (v / 2).saturating_add(30)])
        })
    }

    /// The scene under a rigid motion and an exposure change: output (x, y)
    /// shows the source at `motion(x, y)`, `gain` per mille brighter.
    fn moved_exposed(src: &image::RgbImage, motion: &Rigid, gain: f32) -> image::RgbImage {
        image::RgbImage::from_fn(src.width(), src.height(), |x, y| {
            let (fx, fy) = motion.apply(x as f64, y as f64);
            let sx = (fx.round() as i64).clamp(0, src.width() as i64 - 1) as u32;
            let sy = (fy.round() as i64).clamp(0, src.height() as i64 - 1) as u32;
            let p = src.get_pixel(sx, sy);
            image::Rgb([
                (p.0[0] as f32 * gain).min(255.0) as u8,
                (p.0[1] as f32 * gain).min(255.0) as u8,
                (p.0[2] as f32 * gain).min(255.0) as u8,
            ])
        })
    }

    fn slide(dx: f64, dy: f64) -> Rigid {
        Rigid { cos: 1.0, sin: 0.0, tx: dx, ty: dy }
    }

    fn turn(degrees: f64, width: u32, height: u32) -> Rigid {
        // About the frame's centre, which is where a hand rotates a camera.
        let (sin, cos) = degrees.to_radians().sin_cos();
        let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
        Rigid {
            cos,
            sin,
            tx: cx - (cos * cx - sin * cy),
            ty: cy - (sin * cx + cos * cy),
        }
    }

    #[test]
    fn a_shifted_bracket_comes_back_aligned_and_cropped_to_the_overlap() {
        let mid = scene(640, 480);
        let frames = vec![
            moved_exposed(&mid, &slide(6.0, -4.0), 0.25),
            mid.clone(),
            moved_exposed(&mid, &slide(-5.0, 3.0), 3.0),
        ];
        let merged = merge(&frames).expect("a legitimate bracket");

        assert_eq!(merged.reference, 1, "the middle exposure anchors the bracket");
        let anchor = merged.motions[1].expect("the reference is always included");
        assert!(anchor.tx.abs() < 0.5 && anchor.sin.abs() < 1e-6);
        // The found motions are within a pixel of the truth — inverted,
        // because a motion maps reference coordinates onto the frame, and
        // the fixture built the frame by mapping the other way.
        let dark = merged.motions[0].expect("aligned");
        assert!((dark.tx + 6.0).abs() <= 1.0, "{dark:?}");
        assert!((dark.ty - 4.0).abs() <= 1.0);
        let bright = merged.motions[2].expect("aligned");
        assert!((bright.tx - 5.0).abs() <= 1.0, "{bright:?}");
        assert!((bright.ty + 3.0).abs() <= 1.0);
        // ...and the output gave up exactly the pixels not every frame saw.
        assert!(merged.image.width() < 640 && merged.image.width() >= 640 - 16);
        assert!(merged.image.height() < 480 && merged.image.height() >= 480 - 16);
    }

    #[test]
    fn a_turned_hand_is_aligned_as_a_rotation_not_smeared_as_a_slide() {
        let mid = scene(640, 480);
        let motion = turn(0.4, 640, 480);
        let frames = vec![
            moved_exposed(&mid, &motion, 0.3),
            mid.clone(),
            moved_exposed(&mid, &slide(2.0, 1.0), 2.5),
        ];
        let merged = merge(&frames).expect("a rotated bracket still aligns");
        // Inverted for the same reason as the slides above.
        let found = merged.motions[0].expect("aligned").degrees();
        assert!((found + 0.4).abs() < 0.15, "asked 0.4° (so −0.4° back), found {found:.2}°");
    }

    #[test]
    fn one_frame_is_not_a_bracket() {
        assert!(merge(&[scene(64, 64)]).is_err());
    }

    #[test]
    fn frames_of_different_sizes_are_refused() {
        assert!(merge(&[scene(64, 64), scene(128, 64)]).is_err());
    }

    #[test]
    fn an_unalignable_middle_frame_does_not_sink_the_frames_that_agree() {
        let mid = scene(640, 480);
        // By brightness this sits in the middle of the bracket — exactly
        // where the old fixed anchor lived. An anchor chosen by position
        // would refuse the whole set; the measurements instead pick the
        // run that verifies and merge it.
        let garbage = image::RgbImage::from_fn(640, 480, |x, y| {
            let v = ((x / 7 + y / 11) % 2 * 200) as u8;
            image::Rgb([v, 40, 255 - v])
        });
        let frames = vec![
            moved_exposed(&mid, &slide(4.0, -3.0), 0.25),
            moved_exposed(&mid, &slide(-2.0, 1.0), 0.5),
            garbage,
            moved_exposed(&mid, &slide(1.0, 2.0), 3.0),
        ];
        let merged = merge(&frames).expect("the aligned run still merges");
        assert!(merged.motions[0].is_some());
        assert!(merged.motions[1].is_some());
        assert!(merged.motions[2].is_none(), "the garbage frame is left out");
        assert!(
            merged.motions[3].is_none(),
            "no verified link reaches past the break, even for a frame of the scene"
        );
        assert!(merged.reference == 0 || merged.reference == 1);
    }

    #[test]
    fn frames_of_different_scenes_are_refused_rather_than_ghosted() {
        // Two pictures that share nothing must not come back as one. This
        // is the whole point of verified alignment: the worst output of a
        // merge is not an error, it is a plausible frame with a ghost in it.
        let a = scene(320, 240);
        let b = image::RgbImage::from_fn(320, 240, |x, y| {
            let v = ((x / 7 + y / 11) % 2 * 200) as u8;
            image::Rgb([v, 40, 255 - v])
        });
        assert!(merge(&[a, b]).is_err());
    }
}
