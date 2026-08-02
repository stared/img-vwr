//! The develop-side extension seam.
//!
//! [`codec`](crate::codec) answers "what do these bytes look like" and stops at
//! display-ready RGBA8. Editing needs more: exposure and colour balance are
//! only meaningful on *scene-linear* data, and white balance is only correct
//! when the format plugin applies it in the space the sensor recorded.
//!
//! So a develop-capable format implements [`SceneFormat`]: it opens a file into
//! a [`SceneImage`] that can be re-rendered at any size, under any white
//! balance, into scene-linear floats. Everything after that — exposure, tone,
//! saturation — is format-agnostic and lives in `imgvwr-develop`.
//!
//! The contract is total on purpose: every plugin answers `native_size`,
//! `as_shot` and `render`. A JPEG has no camera white balance to recover, so
//! its plugin reports the D65 it was already balanced to and adapts
//! chromatically from there; a RAW plugin reports what the camera chose and
//! re-runs its pipeline. Callers never branch on the format.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Colour temperature in kelvin plus a green–magenta tint, the two numbers a
/// photographer actually reasons about. Higher `temperature` renders warmer;
/// positive `tint` renders more magenta — the Lightroom convention, which is
/// also what Core Image's RAW pipeline implements.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WhiteBalance {
    pub temperature: f32,
    pub tint: f32,
}

impl WhiteBalance {
    /// The daylight reference an already-balanced (non-RAW) image sits at.
    pub const D65: Self = Self {
        temperature: 6500.0,
        tint: 0.0,
    };
}

/// Scene-linear RGB with sRGB primaries, three channels, no alpha: 1.0 is
/// diffuse white and values above it are real highlight headroom, not error.
/// This is the hand-off type between a format plugin and the develop pipeline.
pub struct LinearImage {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` samples, row-major.
    pub rgb: Vec<f32>,
}

impl LinearImage {
    pub fn pixel_count(&self) -> usize {
        self.width as usize * self.height as usize
    }
}

/// What the caller wants back: a size cap (the plugin picks the cheapest way
/// to hit it) and the white balance to render under.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderRequest {
    /// Longest output edge in pixels; the plugin never upscales past native.
    pub max_edge: u32,
    pub white_balance: WhiteBalance,
}

#[derive(Debug)]
pub enum SceneError {
    Unsupported,
    Open(String),
    Render(String),
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneError::Unsupported => write!(f, "no develop plugin supports this file"),
            SceneError::Open(msg) => write!(f, "open failed: {msg}"),
            SceneError::Render(msg) => write!(f, "render failed: {msg}"),
        }
    }
}

impl std::error::Error for SceneError {}

/// One opened image, held between renders so slider drags are cheap: the
/// expensive work (parsing, demosaicing) happens in [`SceneFormat::open`],
/// and `render` is the part that runs per interaction.
pub trait SceneImage: Send + Sync {
    /// Full sensor/file resolution, after orientation.
    fn native_size(&self) -> (u32, u32);
    /// The white balance the image already carries — the neutral starting
    /// point the UI shows before the user touches anything.
    fn as_shot(&self) -> WhiteBalance;
    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError>;
}

/// A develop-capable format. Registering one is how a new RAW format (or a
/// future WASM plugin host) joins the pipeline.
pub trait SceneFormat: Send + Sync {
    fn id(&self) -> &'static str;
    /// Cheap check: lowercased extension plus the file's first bytes.
    fn probe(&self, ext: &str, magic: &[u8]) -> bool;
    fn open(&self, path: &Path) -> Result<Box<dyn SceneImage>, SceneError>;
}

/// Ordered set of format plugins; first match wins, exactly like
/// [`CodecRegistry`](crate::codec::CodecRegistry).
pub struct SceneRegistry {
    formats: Vec<Arc<dyn SceneFormat>>,
}

impl SceneRegistry {
    pub fn new(formats: Vec<Arc<dyn SceneFormat>>) -> Self {
        Self { formats }
    }

    pub fn find(&self, ext: &str, magic: &[u8]) -> Option<&dyn SceneFormat> {
        self.formats
            .iter()
            .find(|f| f.probe(ext, magic))
            .map(|f| f.as_ref())
    }

    /// Open `path` with the first plugin that claims it. Reads only the file's
    /// first bytes for probing — plugins open the path themselves, because a
    /// RAW decoder may want to stream rather than slurp 18 MB.
    pub fn open(&self, path: &Path) -> Result<Box<dyn SceneImage>, SceneError> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let magic = read_magic(path)?;
        self.find(&ext, &magic)
            .ok_or(SceneError::Unsupported)?
            .open(path)
    }

    pub fn supports(&self, ext: &str) -> bool {
        self.formats.iter().any(|f| f.probe(ext, &[]))
    }
}

fn read_magic(path: &Path) -> Result<Vec<u8>, SceneError> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).map_err(|e| SceneError::Open(e.to_string()))?;
    let mut magic = [0u8; 16];
    let n = file
        .read(&mut magic)
        .map_err(|e| SceneError::Open(e.to_string()))?;
    Ok(magic[..n].to_vec())
}

/* ---------------------------------------------------------------------- */
/*  Colour temperature                                                     */
/* ---------------------------------------------------------------------- */

/// Chromaticity of the illuminant at a given colour temperature.
///
/// Two loci, as photographic white balance uses them: the CIE daylight series
/// at and above 4000 K (so 6504 K lands exactly on D65, which sRGB is defined
/// against and a neutral render depends on), and the Planckian locus below it
/// via Kim et al.'s cubic fit, where real light sources are incandescent.
fn cct_to_xy(temperature: f32) -> (f32, f32) {
    let t = temperature.clamp(1667.0, 25000.0) as f64;
    let (t2, t3) = (t * t, t * t * t);
    if t >= 4000.0 {
        let x = if t <= 7000.0 {
            0.244_063 + 0.099_11e3 / t + 2.967_8e6 / t2 - 4.607_0e9 / t3
        } else {
            0.237_040 + 0.247_48e3 / t + 1.901_8e6 / t2 - 2.006_4e9 / t3
        };
        let y = -3.000 * x * x + 2.870 * x - 0.275;
        return (x as f32, y as f32);
    }

    let x = -0.266_123_9e9 / t3 - 0.234_358_9e6 / t2 + 0.877_695_6e3 / t + 0.179_910;
    let (x2, x3) = (x * x, x * x * x);
    let y = if t <= 2222.0 {
        -1.106_381_4 * x3 - 1.348_110_2 * x2 + 2.185_558_32 * x - 0.202_196_83
    } else {
        -0.954_947_6 * x3 - 1.374_185_93 * x2 + 2.091_370_15 * x - 0.167_488_67
    };
    (x as f32, y as f32)
}

/// Linear-sRGB tristimulus of the illuminant at `temperature`, normalised to
/// unit luminance.
fn illuminant_rgb(temperature: f32) -> [f32; 3] {
    let (x, y) = cct_to_xy(temperature);
    if y <= f32::EPSILON {
        return [1.0, 1.0, 1.0];
    }
    // xyY (Y = 1) → XYZ → linear sRGB (Bradford-adapted D65 matrix).
    let (big_x, big_y, big_z) = (x / y, 1.0, (1.0 - x - y) / y);
    [
        3.240_454_2 * big_x - 1.537_138_5 * big_y - 0.498_531_4 * big_z,
        -0.969_266_0 * big_x + 1.876_010_8 * big_y + 0.041_556_0 * big_z,
        0.055_643_4 * big_x - 0.204_025_9 * big_y + 1.057_225_2 * big_z,
    ]
}

/// Per-channel gains that take an image balanced for `from` and render it as
/// if balanced for `to`. Normalised on green so the change is chromatic only
/// and does not double as an exposure change.
///
/// Used by plugins whose pixels are already demosaiced and balanced (JPEG and
/// friends). A RAW plugin ignores this and re-runs its own pipeline instead,
/// which is more correct because it happens before demosaicing.
pub fn white_balance_gains(from: WhiteBalance, to: WhiteBalance) -> [f32; 3] {
    let src = illuminant_rgb(from.temperature);
    let dst = illuminant_rgb(to.temperature);
    // Warmer target ⇒ the assumed illuminant is redder ⇒ red is scaled up.
    let mut gains = [
        safe_ratio(src[0], dst[0]),
        safe_ratio(src[1], dst[1]),
        safe_ratio(src[2], dst[2]),
    ];
    // Tint moves green against magenta on the same ±150 scale Core Image uses.
    let tint = ((to.tint - from.tint) / 150.0).clamp(-0.9, 0.9);
    gains[1] /= 1.0 + tint;

    let norm = if gains[1].abs() > f32::EPSILON {
        gains[1]
    } else {
        1.0
    };
    [gains[0] / norm, gains[1] / norm, gains[2] / norm]
}

fn safe_ratio(num: f32, den: f32) -> f32 {
    if den.abs() < 1e-6 {
        1.0
    } else {
        (num / den).clamp(0.05, 20.0)
    }
}

/// sRGB electro-optical transfer function: encoded 0–1 → linear.
pub fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse of [`srgb_to_linear`]: linear → encoded 0–1.
pub fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_functions_round_trip() {
        for step in 0..=100 {
            let v = step as f32 / 100.0;
            let round = linear_to_srgb(srgb_to_linear(v));
            assert!((round - v).abs() < 1e-4, "{v} → {round}");
        }
    }

    #[test]
    fn d65_illuminant_is_neutral_in_srgb() {
        let rgb = illuminant_rgb(6504.0);
        // sRGB is defined against D65, so its illuminant must come out grey.
        assert!((rgb[0] - rgb[1]).abs() < 0.02, "{rgb:?}");
        assert!((rgb[2] - rgb[1]).abs() < 0.02, "{rgb:?}");
    }

    #[test]
    fn identical_white_balance_is_a_no_op() {
        let gains = white_balance_gains(WhiteBalance::D65, WhiteBalance::D65);
        for g in gains {
            assert!((g - 1.0).abs() < 1e-5, "{gains:?}");
        }
    }

    #[test]
    fn raising_temperature_warms_the_image() {
        let warmer = white_balance_gains(
            WhiteBalance::D65,
            WhiteBalance {
                temperature: 9000.0,
                tint: 0.0,
            },
        );
        assert!(warmer[0] > 1.0, "red should gain: {warmer:?}");
        assert!(warmer[2] < 1.0, "blue should drop: {warmer:?}");

        let cooler = white_balance_gains(
            WhiteBalance::D65,
            WhiteBalance {
                temperature: 3500.0,
                tint: 0.0,
            },
        );
        assert!(cooler[0] < 1.0, "red should drop: {cooler:?}");
        assert!(cooler[2] > 1.0, "blue should gain: {cooler:?}");
    }

    #[test]
    fn positive_tint_pushes_towards_magenta() {
        let gains = white_balance_gains(
            WhiteBalance::D65,
            WhiteBalance {
                temperature: 6500.0,
                tint: 50.0,
            },
        );
        // Green normalised to 1; magenta means red and blue rise above it.
        assert!((gains[1] - 1.0).abs() < 1e-5);
        assert!(gains[0] > 1.0 && gains[2] > 1.0, "{gains:?}");
    }

    #[test]
    fn gains_stay_finite_at_the_extremes() {
        for temp in [1000.0, 1667.0, 25000.0, 40000.0] {
            let gains = white_balance_gains(
                WhiteBalance::D65,
                WhiteBalance {
                    temperature: temp,
                    tint: 0.0,
                },
            );
            assert!(gains.iter().all(|g| g.is_finite() && *g > 0.0), "{gains:?}");
        }
    }
}
