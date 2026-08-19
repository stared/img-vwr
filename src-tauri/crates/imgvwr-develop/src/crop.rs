//! Rotation is only correct in an isotropic space: normalised coordinates stretch x by the
//! aspect, so every rotation here converts to a square space, turns, and converts back — skipping
//! that shears the picture, subtly enough at small angles to look like sloppy interpolation.
//! An unrotated crop hands its region straight to the plugin and never resamples a pixel.

use imgvwr_core::{LinearImage, Region};
use serde::{Deserialize, Serialize};

/// The rectangle in normalised original-frame coordinates; the rectangle itself is axis-aligned in the frame rotated by `angle`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Degrees clockwise; positive straightens a horizon that falls to the right.
    pub angle: f32,
}

/// Beyond this the corners drag in empty area from outside the frame.
const MAX_ANGLE: f32 = 45.0;

/// Smaller than this and a crop is a mistake rather than an intention.
const MIN_EXTENT: f32 = 0.02;

impl Default for Crop {
    fn default() -> Self {
        Self::FULL
    }
}

impl Crop {
    pub const FULL: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        angle: 0.0,
    };

    pub fn is_full(&self) -> bool {
        *self == Self::FULL
    }

    pub fn is_axis_aligned(&self) -> bool {
        self.angle == 0.0
    }

    pub fn clamped(&self) -> Self {
        let width = clamp_finite(self.width, MIN_EXTENT, 1.0);
        let height = clamp_finite(self.height, MIN_EXTENT, 1.0);
        Self {
            // A rotated rectangle may pass the edge: its bounding box always does, and clamping that would refuse legitimate crops.
            x: clamp_finite(self.x, 0.0, 1.0 - width),
            y: clamp_finite(self.y, 0.0, 1.0 - height),
            width,
            height,
            angle: clamp_finite(self.angle, -MAX_ANGLE, MAX_ANGLE),
        }
    }

    fn centre(&self) -> (f32, f32) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// Offset from the crop's centre in the rotated frame → the original frame's normalised coordinates. `aspect` is width over height; without it the rotation shears.
    fn rotated_to_original(&self, dx: f32, dy: f32, aspect: f32) -> (f32, f32) {
        let (cx, cy) = self.centre();
        let (sin, cos) = self.angle.to_radians().sin_cos();
        // Into a square space, turn, and back out.
        let (ix, iy) = (dx * aspect, dy);
        let (rx, ry) = (ix * cos - iy * sin, ix * sin + iy * cos);
        (cx + rx / aspect, cy + ry)
    }

    /// A point in the cropped image's own coordinates, expressed in the original frame's — what the eyedropper needs.
    pub fn point_in_original(&self, u: f32, v: f32, aspect: f32) -> (f32, f32) {
        let (x, y) = self.rotated_to_original((u - 0.5) * self.width, (v - 0.5) * self.height, aspect);
        (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))
    }

    /// The axis-aligned part of the original frame containing this crop — what a plugin must render first.
    pub fn source_region(&self, aspect: f32) -> Region {
        if self.is_axis_aligned() {
            return Region {
                x: self.x,
                y: self.y,
                width: self.width,
                height: self.height,
            };
        }
        let (hw, hh) = (self.width / 2.0, self.height / 2.0);
        let corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
            .map(|(dx, dy)| self.rotated_to_original(dx, dy, aspect));
        let min_x = corners.iter().map(|c| c.0).fold(f32::MAX, f32::min);
        let max_x = corners.iter().map(|c| c.0).fold(f32::MIN, f32::max);
        let min_y = corners.iter().map(|c| c.1).fold(f32::MAX, f32::min);
        let max_y = corners.iter().map(|c| c.1).fold(f32::MIN, f32::max);
        Region {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        }
        .clamped()
    }

    /// Narrowed to a sub-rectangle given in the cropped image's own coordinates: zooming composes into one smaller crop instead of a full render followed by a discard.
    pub fn narrowed(&self, region: Region, aspect: f32) -> Self {
        if region.is_full() {
            return *self;
        }
        let r = region.clamped();
        // The sub-rectangle's centre as an offset from this crop's centre, in the rotated frame.
        let dx = (r.x + r.width / 2.0 - 0.5) * self.width;
        let dy = (r.y + r.height / 2.0 - 0.5) * self.height;
        let (cx, cy) = self.rotated_to_original(dx, dy, aspect);
        let (width, height) = (self.width * r.width, self.height * r.height);
        Self {
            x: cx - width / 2.0,
            y: cy - height / 2.0,
            width,
            height,
            angle: self.angle,
        }
    }

    pub fn output_size(&self, native: (u32, u32), max_edge: u32) -> (u32, u32) {
        let w = self.width * native.0 as f32;
        let h = self.height * native.1 as f32;
        let longest = w.max(h).max(1.0);
        // Never upscale: more than the crop contains would be invented detail.
        let scale = (max_edge.max(1) as f32 / longest).min(1.0);
        (
            ((w * scale).round() as u32).max(1),
            ((h * scale).round() as u32).max(1),
        )
    }
}

/// `source` covers `region` of the original frame; the result is `crop` at `out` pixels.
/// Bilinear — nearest-neighbour turns a straightened horizon into a staircase.
pub fn resample(
    source: &LinearImage,
    region: Region,
    crop: &Crop,
    aspect: f32,
    out: (u32, u32),
) -> LinearImage {
    let (ow, oh) = (out.0.max(1), out.1.max(1));
    let mut rgb = vec![0f32; ow as usize * oh as usize * 3];
    let (sw, sh) = (source.width as f32, source.height as f32);

    for j in 0..oh {
        for i in 0..ow {
            // This output pixel as an offset from the crop's centre, in the rotated frame.
            let dx = ((i as f32 + 0.5) / ow as f32 - 0.5) * crop.width;
            let dy = ((j as f32 + 0.5) / oh as f32 - 0.5) * crop.height;
            let (ox, oy) = crop.rotated_to_original(dx, dy, aspect);

            // ...and where that lands in the patch we were given.
            let u = (ox - region.x) / region.width.max(f32::EPSILON) * sw - 0.5;
            let v = (oy - region.y) / region.height.max(f32::EPSILON) * sh - 0.5;

            let out_i = ((j as usize * ow as usize) + i as usize) * 3;
            let sample = bilinear(source, u, v);
            rgb[out_i] = sample[0];
            rgb[out_i + 1] = sample[1];
            rgb[out_i + 2] = sample[2];
        }
    }

    LinearImage {
        width: ow,
        height: oh,
        rgb,
    }
}

/// Clamps at the edges rather than returning black: a rotated crop's corners can fall a fraction
/// of a pixel outside the rendered patch, and a black fringe there is a defect made of rounding.
fn bilinear(src: &LinearImage, u: f32, v: f32) -> [f32; 3] {
    let (w, h) = (src.width as i64, src.height as i64);
    if w == 0 || h == 0 {
        return [0.0; 3];
    }
    let x0 = u.floor();
    let y0 = v.floor();
    let fx = u - x0;
    let fy = v - y0;
    let at = |x: i64, y: i64| -> [f32; 3] {
        let x = x.clamp(0, w - 1) as usize;
        let y = y.clamp(0, h - 1) as usize;
        let i = (y * src.width as usize + x) * 3;
        [src.rgb[i], src.rgb[i + 1], src.rgb[i + 2]]
    };
    let (x0, y0) = (x0 as i64, y0 as i64);
    let (a, b, c, d) = (
        at(x0, y0),
        at(x0 + 1, y0),
        at(x0, y0 + 1),
        at(x0 + 1, y0 + 1),
    );
    let mut out = [0f32; 3];
    for k in 0..3 {
        let top = a[k] + (b[k] - a[k]) * fx;
        let bottom = c[k] + (d[k] - c[k]) * fx;
        out[k] = top + (bottom - top) * fy;
    }
    out
}

fn clamp_finite(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi.max(lo))
    } else {
        lo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> LinearImage {
        // A ramp in x and y, so a resampled pixel's value says exactly where
        // it was taken from.
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                rgb.push(x as f32 / w as f32);
                rgb.push(y as f32 / h as f32);
                rgb.push(0.0);
            }
        }
        LinearImage {
            width: w,
            height: h,
            rgb,
        }
    }

    #[test]
    fn the_whole_frame_is_recognised_and_costs_nothing() {
        assert!(Crop::FULL.is_full());
        assert!(Crop::FULL.is_axis_aligned());
        assert_eq!(Crop::FULL.source_region(1.5), Region::FULL);
    }

    #[test]
    fn an_unrotated_crop_is_its_own_region() {
        let crop = Crop {
            x: 0.25,
            y: 0.1,
            width: 0.5,
            height: 0.4,
            angle: 0.0,
        };
        let region = crop.source_region(1.5);
        assert_eq!((region.x, region.y), (0.25, 0.1));
        assert_eq!((region.width, region.height), (0.5, 0.4));
    }

    #[test]
    fn a_rotated_crop_asks_for_more_than_it_keeps() {
        let straight = Crop {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            angle: 0.0,
        };
        let tilted = Crop {
            angle: 10.0,
            ..straight
        };
        let a = straight.source_region(1.0);
        let b = tilted.source_region(1.0);
        assert!(b.width > a.width && b.height > a.height, "{b:?} vs {a:?}");
    }

    #[test]
    fn rotation_does_not_shear_a_non_square_frame() {
        let crop = Crop {
            x: 0.2,
            y: 0.2,
            width: 0.4,
            height: 0.4,
            angle: 30.0,
        };
        let aspect = 2.0;
        let (hw, hh) = (0.2, 0.2);
        let corners: Vec<(f32, f32)> = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
            .iter()
            .map(|(dx, dy)| crop.rotated_to_original(*dx, *dy, aspect))
            .collect();
        let (cx, cy) = crop.centre();

        // Opposite corners are reflections through the centre.
        for (a, b) in [(0, 2), (1, 3)] {
            assert!((corners[a].0 + corners[b].0 - 2.0 * cx).abs() < 1e-5);
            assert!((corners[a].1 + corners[b].1 - 2.0 * cy).abs() < 1e-5);
        }
        // Adjacent edges perpendicular — measured in the square space, where "perpendicular" is meaningful.
        let edge = |a: usize, b: usize| {
            (
                (corners[b].0 - corners[a].0) * aspect,
                corners[b].1 - corners[a].1,
            )
        };
        let (e1, e2) = (edge(0, 1), edge(1, 2));
        assert!((e1.0 * e2.0 + e1.1 * e2.1).abs() < 1e-5, "{e1:?} · {e2:?}");
    }

    #[test]
    fn narrowing_by_the_full_region_changes_nothing() {
        let crop = Crop {
            x: 0.1,
            y: 0.2,
            width: 0.5,
            height: 0.3,
            angle: 7.0,
        };
        assert_eq!(crop.narrowed(Region::FULL, 1.5), crop);
    }

    #[test]
    fn narrowing_composes_instead_of_rendering_and_discarding() {
        // The middle quarter of a crop is the crop covering that quarter — same centre, half the extent.
        let crop = Crop {
            x: 0.2,
            y: 0.2,
            width: 0.6,
            height: 0.6,
            angle: 0.0,
        };
        let middle = Region {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        };
        let inner = crop.narrowed(middle, 1.0);
        assert!((inner.width - 0.3).abs() < 1e-6);
        assert!((inner.height - 0.3).abs() < 1e-6);
        assert!((inner.x - 0.35).abs() < 1e-6, "{inner:?}");
        assert!((inner.y - 0.35).abs() < 1e-6, "{inner:?}");
    }

    #[test]
    fn narrowing_a_rotated_crop_keeps_its_angle_and_stays_inside_it() {
        let crop = Crop {
            x: 0.2,
            y: 0.2,
            width: 0.6,
            height: 0.6,
            angle: 15.0,
        };
        let inner = crop.narrowed(
            Region {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            },
            1.0,
        );
        assert_eq!(inner.angle, 15.0);
        assert!(inner.width < crop.width && inner.height < crop.height);
    }

    #[test]
    fn output_size_follows_the_crop_and_never_upscales() {
        let half = Crop {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 0.25,
            angle: 0.0,
        };
        // A half-by-quarter crop of 4000x2000 is 2000x500; held to 1000 it becomes 1000x250.
        assert_eq!(half.output_size((4000, 2000), 1000), (1000, 250));
        assert_eq!(half.output_size((4000, 2000), 9000), (2000, 500));
    }

    #[test]
    fn resampling_an_unrotated_crop_reproduces_the_patch() {
        // `region` says what the source covers (the whole frame here); getting that pairing wrong is the easiest calling mistake.
        let src = gradient(64, 64);
        let crop = Crop {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            angle: 0.0,
        };
        let out = resample(&src, Region::FULL, &crop, 1.0, (32, 32));
        assert_eq!((out.width, out.height), (32, 32));

        assert!((out.rgb[0] - 0.25).abs() < 0.03, "{}", out.rgb[0]);
        let last = (31 * 32 + 31) * 3;
        assert!((out.rgb[last] - 0.75).abs() < 0.03, "{}", out.rgb[last]);
    }

    #[test]
    fn resampling_never_reads_outside_the_patch_it_was_given() {
        let src = gradient(32, 32);
        let crop = Crop {
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.9,
            angle: 20.0,
        };
        let out = resample(&src, Region::FULL, &crop, 1.0, (24, 24));
        assert!(out.rgb.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
    }

    #[test]
    fn a_point_on_the_crop_maps_back_to_where_it_is_on_the_sensor() {
        let crop = Crop {
            x: 0.5,
            y: 0.5,
            width: 0.4,
            height: 0.4,
            angle: 0.0,
        };
        let (x, y) = crop.point_in_original(0.5, 0.5, 1.0);
        assert!((x - 0.7).abs() < 1e-5 && (y - 0.7).abs() < 1e-5, "{x} {y}");

        let (tx, ty) = crop.point_in_original(0.0, 0.0, 1.0);
        assert!((tx - 0.5).abs() < 1e-5 && (ty - 0.5).abs() < 1e-5);

        // Never outside the frame, whatever the rotation drags in.
        let turned = Crop { angle: 30.0, ..crop };
        for (u, v) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
            let (px, py) = turned.point_in_original(u, v, 1.0);
            assert!((0.0..=1.0).contains(&px) && (0.0..=1.0).contains(&py));
        }
    }

    #[test]
    fn clamping_keeps_a_rectangle_usable() {
        let wild = Crop {
            x: -5.0,
            y: 9.0,
            width: 0.0,
            height: 40.0,
            angle: 900.0,
        }
        .clamped();
        assert!(wild.width >= MIN_EXTENT && wild.height <= 1.0);
        assert!(wild.x >= 0.0 && wild.y >= 0.0);
        assert_eq!(wild.angle, MAX_ANGLE);

        let nan = Crop {
            x: f32::NAN,
            y: 0.0,
            width: f32::NAN,
            height: 0.5,
            angle: f32::INFINITY,
        }
        .clamped();
        assert!(nan.x.is_finite() && nan.width.is_finite() && nan.angle.is_finite());
    }
}
