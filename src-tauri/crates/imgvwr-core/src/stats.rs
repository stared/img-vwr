use serde::Serialize;

use crate::codec::DecodedImage;

/// Rows in the color-triangle tessellation (N² small triangles).
pub const TRIANGLE_N: usize = 48;

/// Computed from the cached thumbnail; the original is never re-decoded for stats.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageStats {
    /// 256-bin histograms: Rec. 709 luma and the three channels.
    pub luma: Vec<u32>,
    pub red: Vec<u32>,
    pub green: Vec<u32>,
    pub blue: Vec<u32>,
    /// Maxwell-triangle density: ▲ cells at `[b*N + a]` for a + b ≤ N-1, ▽ for a + b ≤ N-2 (a, b = barycentric red/green × N).
    /// Both vectors are N×N with structurally empty slots at zero.
    pub triangle_n: u32,
    pub tri_up: Vec<u32>,
    pub tri_down: Vec<u32>,
}

pub fn image_stats(img: &DecodedImage) -> ImageStats {
    let mut luma = vec![0u32; 256];
    let mut red = vec![0u32; 256];
    let mut green = vec![0u32; 256];
    let mut blue = vec![0u32; 256];
    let n = TRIANGLE_N;
    let mut tri_up = vec![0u32; n * n];
    let mut tri_down = vec![0u32; n * n];

    for px in img.rgba.chunks_exact(4) {
        let (r, g, b) = (px[0], px[1], px[2]);
        red[r as usize] += 1;
        green[g as usize] += 1;
        blue[b as usize] += 1;
        let y = 0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b);
        luma[(y.round() as usize).min(255)] += 1;

        let sum = u32::from(r) + u32::from(g) + u32::from(b);
        let (u, v) = if sum == 0 {
            (1.0 / 3.0, 1.0 / 3.0) // pure black is colorless: center
        } else {
            (f32::from(r) / sum as f32, f32::from(g) / sum as f32)
        };
        // Up-cell when the fractional parts stay under the cell's diagonal.
        let (su, sv) = (u * n as f32, v * n as f32);
        let a = (su as usize).min(n - 1);
        let mut b = (sv as usize).min(n - 1);
        if a + b > n - 1 {
            // Float edge: clamp back onto the simplex boundary.
            b = n - 1 - a;
        }
        // Down cells only exist strictly inside the simplex (a + b ≤ N-2).
        let up = (su - a as f32) + (sv - b as f32) <= 1.0 || a + b == n - 1;
        if up {
            tri_up[b * n + a] += 1;
        } else {
            tri_down[b * n + a] += 1;
        }
    }

    ImageStats {
        luma,
        red,
        green,
        blue,
        triangle_n: n as u32,
        tri_up,
        tri_down,
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
        assert_eq!(stats.luma[0], 1);
        assert_eq!(stats.luma[54], 2); // 0.2126 * 255 ≈ 54
        assert_eq!(stats.luma.iter().sum::<u32>(), 3);
    }

    #[test]
    fn triangle_puts_pure_red_in_the_red_corner_and_gray_in_the_center() {
        let stats = image_stats(&img(&[[255, 0, 0, 255], [128, 128, 128, 255]]));
        let n = TRIANGLE_N;
        // Pure red: u = 1 → the up-cell at the red corner (a = N-1, b = 0).
        assert_eq!(stats.tri_up[n - 1], 1);
        // Gray: u = v = 1/3 → an up cell at the center.
        let center = n / 3;
        assert_eq!(stats.tri_up[center * n + center], 1);
        let total: u32 =
            stats.tri_up.iter().sum::<u32>() + stats.tri_down.iter().sum::<u32>();
        assert_eq!(total, 2);
    }
}
