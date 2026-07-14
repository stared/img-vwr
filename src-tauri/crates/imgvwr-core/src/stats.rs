use serde::Serialize;

use crate::codec::DecodedImage;

/// Cells per side of the color-triangle density grid.
pub const TRIANGLE_GRID: usize = 48;

/// Per-image pixel statistics for the info panel, computed from the cached
/// thumbnail (256 px is plenty for distribution shapes and it is already on
/// disk — the original is never re-decoded for this).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageStats {
    /// 256-bin histograms: Rec. 709 luma and the three channels.
    pub luma: Vec<u32>,
    pub red: Vec<u32>,
    pub green: Vec<u32>,
    pub blue: Vec<u32>,
    /// Maxwell-triangle density: `TRIANGLE_GRID`² cells over barycentric
    /// RGB coordinates (x = r/(r+g+b), y = g/(r+g+b)), row-major; cells
    /// with x + y > 1 are structurally empty. Grayscale pixels land in the
    /// center cell.
    pub triangle: Vec<u32>,
    pub triangle_grid: u32,
}

pub fn image_stats(img: &DecodedImage) -> ImageStats {
    let mut luma = vec![0u32; 256];
    let mut red = vec![0u32; 256];
    let mut green = vec![0u32; 256];
    let mut blue = vec![0u32; 256];
    let mut triangle = vec![0u32; TRIANGLE_GRID * TRIANGLE_GRID];

    for px in img.rgba.chunks_exact(4) {
        let (r, g, b) = (px[0], px[1], px[2]);
        red[r as usize] += 1;
        green[g as usize] += 1;
        blue[b as usize] += 1;
        let y = 0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b);
        luma[(y.round() as usize).min(255)] += 1;

        let sum = u32::from(r) + u32::from(g) + u32::from(b);
        let (x_frac, y_frac) = if sum == 0 {
            (1.0 / 3.0, 1.0 / 3.0) // pure black is colorless: center
        } else {
            (f32::from(r) / sum as f32, f32::from(g) / sum as f32)
        };
        let col = ((x_frac * TRIANGLE_GRID as f32) as usize).min(TRIANGLE_GRID - 1);
        let row = ((y_frac * TRIANGLE_GRID as f32) as usize).min(TRIANGLE_GRID - 1);
        triangle[row * TRIANGLE_GRID + col] += 1;
    }

    ImageStats {
        luma,
        red,
        green,
        blue,
        triangle,
        triangle_grid: TRIANGLE_GRID as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(pixels: &[[u8; 4]]) -> DecodedImage {
        DecodedImage {
            width: pixels.len() as u32,
            height: 1,
            rgba: pixels.iter().flatten().copied().collect(),
        }
    }

    #[test]
    fn histograms_count_channels_and_luma() {
        let stats = image_stats(&img(&[[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 255]]));
        assert_eq!(stats.red[255], 2);
        assert_eq!(stats.red[0], 1);
        assert_eq!(stats.green[0], 3);
        assert_eq!(stats.luma[0], 1); // black
        assert_eq!(stats.luma[54], 2); // 0.2126 * 255 ≈ 54
        assert_eq!(stats.luma.iter().sum::<u32>(), 3);
    }

    #[test]
    fn triangle_puts_pure_red_in_the_red_corner_and_gray_in_the_center() {
        let stats = image_stats(&img(&[[255, 0, 0, 255], [128, 128, 128, 255]]));
        let grid = TRIANGLE_GRID;
        // Pure red: x = 1 → last column of row 0.
        assert_eq!(stats.triangle[grid - 1], 1);
        // Gray: x = y = 1/3 → the center-ish cell.
        let center = grid / 3;
        assert_eq!(stats.triangle[center * grid + center], 1);
        assert_eq!(stats.triangle.iter().sum::<u32>(), 2);
    }
}
