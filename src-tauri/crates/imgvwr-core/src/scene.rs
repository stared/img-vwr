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

/// A rectangle of the image in normalised coordinates: (0,0) is the top-left
/// of the oriented frame and (1,1) the bottom-right.
///
/// Normalised rather than in pixels so a caller can ask for "the middle of
/// the picture" without first learning how many pixels the sensor has, and so
/// the same region means the same thing at preview and full resolution.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Region {
    /// The whole frame.
    pub const FULL: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };

    pub fn is_full(&self) -> bool {
        *self == Self::FULL
    }

    /// Clamped to the frame, and never empty.
    pub fn clamped(&self) -> Self {
        let x = self.x.clamp(0.0, 1.0);
        let y = self.y.clamp(0.0, 1.0);
        Self {
            x,
            y,
            width: self.width.clamp(f32::EPSILON, 1.0 - x),
            height: self.height.clamp(f32::EPSILON, 1.0 - y),
        }
    }

    /// Pixel rect within an image of this size: (x, y, width, height), with
    /// width and height at least one pixel.
    pub fn to_pixels(&self, width: u32, height: u32) -> (u32, u32, u32, u32) {
        let r = self.clamped();
        let px = (r.x * width as f32).round() as u32;
        let py = (r.y * height as f32).round() as u32;
        let pw = ((r.width * width as f32).round() as u32).clamp(1, width.saturating_sub(px).max(1));
        let ph =
            ((r.height * height as f32).round() as u32).clamp(1, height.saturating_sub(py).max(1));
        (px.min(width - 1), py.min(height - 1), pw, ph)
    }
}

/// What the caller wants back: which part of the image, how big, and under
/// what white balance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderRequest {
    /// Longest output edge in pixels; the plugin never upscales past native.
    pub max_edge: u32,
    pub white_balance: WhiteBalance,
    /// Which part of the frame to render. Rendering a crop is what makes
    /// inspecting a 24 MP file at 1:1 affordable — only the visible part is
    /// ever developed.
    pub region: Region,
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

/// Whether a plugin's pixels have already had somebody's rendering applied.
///
/// The difference decides whether a look should be chosen for the image. A raw
/// file is measurements: flat by construction, and a camera would have applied
/// a curve to it before showing it to anyone. A JPEG is already a finished
/// picture — whoever made it chose the look, and applying another on open
/// would apply it twice.
///
/// A closed enum rather than an `is_raw` flag, because the question is about
/// what the pixels *are* and not what the file extension says. Callers match
/// on it instead of asking about formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Rendering {
    /// Straight from the sensor, expecting a look to be chosen.
    SceneReferred,
    /// Rendered by whatever wrote the file.
    AlreadyRendered,
}

/// One opened image, held between renders so slider drags are cheap: the
/// expensive work (parsing, demosaicing) happens in [`SceneFormat::open`],
/// and `render` is the part that runs per interaction.
pub trait SceneImage: Send + Sync {
    /// Full sensor/file resolution, after orientation.
    fn native_size(&self) -> (u32, u32);
    /// Whether these pixels still want a look chosen for them.
    fn rendering(&self) -> Rendering;
    /// The white balance the image already carries — the neutral starting
    /// point the UI shows before the user touches anything.
    fn as_shot(&self) -> WhiteBalance;
    fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError>;
    /// The white balance that renders the point at normalised (x, y) neutral
    /// — the eyedropper.
    ///
    /// Part of the contract rather than a free function so a plugin whose
    /// decoder can answer this natively is free to. Neither current plugin
    /// can — Core Image exposes a `neutralLocation` property that measurably
    /// does nothing to the derived temperature and tint — so both delegate to
    /// [`neutral_by_measurement`], which develops a small patch and solves
    /// for the balance that greys it.
    fn neutral_at(&self, x: f32, y: f32, current: WhiteBalance)
        -> Result<WhiteBalance, SceneError>;
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

/// Eyedropper by measurement: develop a small patch around the point under
/// the current balance, then solve for the balance that would render it grey.
///
/// The shared implementation of [`SceneImage::neutral_at`]. Averaging a patch
/// rather than sampling one pixel matters — a single pixel of a photograph is
/// substantially noise, and the user is pointing at a surface.
///
/// ## Why this measures more than once
///
/// [`white_balance_for_sample`] answers with *our* illuminant model, and a
/// plugin is free to implement temperature by some other one. The raw plugin
/// hands the setting to Core Image, which — measured against real NEFs by
/// `cargo run -p imgvwr-raw --example audit` — moves red against blue about
/// half again as far per kelvin as our model expects. A single solve therefore
/// lands well past the mark: on a real file it overshoots hard enough to
/// reverse the cast it was asked to remove.
///
/// So the answer is checked against the plugin rather than trusted. Each round
/// renders the patch again, and the size of the move that produced the change
/// gives the plugin's actual sensitivity — after which the next proposal is
/// scaled by it. That is a secant step, and it converges for any plugin whose
/// response merely points the right way; plain re-solving does not, because a
/// plugin twice as strong as the model oscillates instead of settling.
///
/// None of this needs to know that Core Image is on the other side, which is
/// the point of the seam.
pub fn neutral_by_measurement(
    scene: &dyn SceneImage,
    x: f32,
    y: f32,
    current: WhiteBalance,
) -> Result<WhiteBalance, SceneError> {
    const PATCH: f32 = 0.01;
    /// One uncalibrated step plus a few corrected ones. Each is a one-pixel
    /// render of a hundredth of the frame, so this is cheap even on RAW.
    const ROUNDS: usize = 4;
    /// A patch this close to neutral is neutral; further rounds would be
    /// chasing sensor noise.
    const CLOSE_ENOUGH: f32 = 0.005;
    /// How far the plugin's sensitivity is allowed to be believed. A wild
    /// estimate from a near-zero move must not throw the search.
    const SENSITIVITY: std::ops::Range<f32> = 0.25..4.0;

    let region = Region {
        x: x - PATCH / 2.0,
        y: y - PATCH / 2.0,
        width: PATCH,
        height: PATCH,
    };
    let measure = |balance: WhiteBalance| -> Result<[f32; 3], SceneError> {
        let sampled = scene.render(RenderRequest {
            max_edge: 1,
            white_balance: balance,
            region,
        })?;
        Ok([
            *sampled.rgb.first().unwrap_or(&0.0),
            *sampled.rgb.get(1).unwrap_or(&0.0),
            *sampled.rgb.get(2).unwrap_or(&0.0),
        ])
    };

    let mut balance = current;
    let mut rgb = measure(balance)?;
    // Where the previous round stood, and how warm the patch was there —
    // the two points a secant step is drawn through.
    let mut previous: Option<(WhiteBalance, f32)> = None;

    for _ in 0..ROUNDS {
        let max = rgb[0].max(rgb[1]).max(rgb[2]);
        let min = rgb[0].min(rgb[1]).min(rgb[2]);
        if max <= 1e-6 {
            break; // black patch: nothing to balance against
        }
        if (max - min) / max <= CLOSE_ENOUGH {
            break;
        }

        // How strongly the plugin answered the last move, relative to what our
        // model predicted for it. Unknown on the first round, when the model
        // is the only guess available.
        let sensitivity = previous
            .and_then(|(from, was)| {
                let gains = white_balance_gains(from, balance);
                let predicted = safe_ratio(gains[0], gains[2]).ln();
                let observed = warmth(rgb) - was;
                (predicted.abs() > 1e-3).then_some(observed / predicted)
            })
            .filter(|s| SENSITIVITY.contains(s))
            .unwrap_or(1.0);

        let proposed = white_balance_for_sample(balance, rgb);
        // Scaled in log-temperature, because temperature acts multiplicatively
        // — 500 K is a large move at 3000 K and a small one at 9000 K.
        let next = WhiteBalance {
            temperature: (balance.temperature.ln()
                + (proposed.temperature.ln() - balance.temperature.ln()) / sensitivity)
                .exp()
                .clamp(1667.0, 25000.0),
            tint: balance.tint + (proposed.tint - balance.tint) / sensitivity,
        };
        if next == balance {
            break; // the solver has nothing left to move
        }

        previous = Some((balance, warmth(rgb)));
        balance = next;
        rgb = measure(balance)?;
    }
    Ok(balance)
}

/// Red against blue, in log terms — the axis colour temperature moves along.
/// Log because the controls are multiplicative and the errors compose.
fn warmth(rgb: [f32; 3]) -> f32 {
    safe_ratio(rgb[0], rgb[2]).ln()
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

/// White balance that would render `sample` neutral, given that `sample` was
/// measured under `current`.
///
/// This is the eyedropper: the user says "this patch is grey", and the answer
/// is the temperature and tint that make it so. Solved by search rather than
/// algebra because the map from temperature to channel gains runs through two
/// different loci and has no useful closed-form inverse — but it is a smooth
/// 1-D problem over a bounded range, so a coarse-then-fine sweep lands within
/// a few kelvin for a fraction of the cost of one render.
pub fn white_balance_for_sample(current: WhiteBalance, sample: [f32; 3]) -> WhiteBalance {
    // What the sample needs multiplying by to become neutral, on top of
    // whatever the current setting already applies.
    let mid = (sample[0] + sample[1] + sample[2]) / 3.0;
    if !mid.is_finite() || mid <= 1e-6 {
        return current; // black or nonsense: nothing to balance against
    }
    let wanted = [
        safe_ratio(mid, sample[0]),
        safe_ratio(mid, sample[1]),
        safe_ratio(mid, sample[2]),
    ];
    // Gains are scale-free (green-normalised), so compare red-vs-blue only.
    let target = safe_ratio(wanted[0], wanted[2]);

    let error_at = |temperature: f32| {
        let g = white_balance_gains(
            current,
            WhiteBalance {
                temperature,
                tint: current.tint,
            },
        );
        (safe_ratio(g[0], g[2]) / target).ln().abs()
    };

    let mut best = current.temperature;
    let mut best_error = f32::MAX;
    let mut lo = 1667.0f32;
    let mut hi = 25000.0f32;
    for _ in 0..4 {
        let step = (hi - lo) / 24.0;
        let mut t = lo;
        while t <= hi {
            let e = error_at(t);
            if e < best_error {
                best_error = e;
                best = t;
            }
            t += step;
        }
        lo = (best - step).max(1667.0);
        hi = (best + step).min(25000.0);
    }

    // Temperature only moves red against blue, so whatever green cast is
    // left over is exactly what tint is for. Gains are green-normalised, so
    // the leftover is green measured against the red/blue average.
    let residual_green = safe_ratio(wanted[1], (wanted[0] * wanted[2]).sqrt());
    // Tint divides green by (1 + tint/150); needing `residual_green` more
    // green therefore means moving tint by 150 * (1/residual - 1).
    let delta_tint = 150.0 * (1.0 / residual_green - 1.0);
    let tint = (current.tint + delta_tint).clamp(-150.0, 150.0);

    WhiteBalance {
        temperature: best,
        tint,
    }
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
    fn full_region_covers_the_whole_frame() {
        assert!(Region::FULL.is_full());
        assert_eq!(Region::FULL.to_pixels(100, 50), (0, 0, 100, 50));
    }

    #[test]
    fn region_maps_to_pixels() {
        let middle = Region {
            x: 0.25,
            y: 0.5,
            width: 0.5,
            height: 0.25,
        };
        assert_eq!(middle.to_pixels(400, 200), (100, 100, 200, 50));
    }

    #[test]
    fn region_clamps_to_the_frame_and_never_empties() {
        let overhanging = Region {
            x: 0.8,
            y: 0.9,
            width: 0.5,
            height: 0.5,
        };
        let (x, y, w, h) = overhanging.to_pixels(100, 100);
        assert!(x + w <= 100 && y + h <= 100, "stays inside: {x} {y} {w} {h}");
        assert!(w >= 1 && h >= 1);

        let negative = Region {
            x: -1.0,
            y: -1.0,
            width: 0.2,
            height: 0.2,
        };
        let (x, y, w, h) = negative.to_pixels(100, 100);
        assert_eq!((x, y), (0, 0));
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn a_degenerate_region_still_yields_a_pixel() {
        let sliver = Region {
            x: 0.5,
            y: 0.5,
            width: 0.0,
            height: 0.0,
        };
        let (_, _, w, h) = sliver.to_pixels(100, 100);
        assert_eq!((w, h), (1, 1));
    }

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
    fn picking_an_already_neutral_patch_changes_nothing() {
        let current = WhiteBalance {
            temperature: 5300.0,
            tint: 12.0,
        };
        let picked = white_balance_for_sample(current, [0.4, 0.4, 0.4]);
        assert!(
            (picked.temperature - current.temperature).abs() < 400.0,
            "temperature held: {picked:?}"
        );
        assert!((picked.tint - current.tint).abs() < 5.0, "tint held: {picked:?}");
    }

    #[test]
    fn picking_a_blue_patch_warms_the_render() {
        // The patch came out blue, so the render is too cool for the light
        // that was really there; neutralising it means warming up. Raising
        // the temperature is what warms, per `raising_temperature_warms_the_image`.
        let current = WhiteBalance::D65;
        let picked = white_balance_for_sample(current, [0.20, 0.30, 0.50]);
        assert!(
            picked.temperature > current.temperature,
            "expected a warmer setting, got {picked:?}"
        );
    }

    #[test]
    fn picking_an_orange_patch_cools_the_render() {
        let current = WhiteBalance::D65;
        let picked = white_balance_for_sample(current, [0.50, 0.30, 0.18]);
        assert!(
            picked.temperature < current.temperature,
            "expected a cooler setting, got {picked:?}"
        );
    }

    #[test]
    fn picking_a_green_patch_moves_tint_towards_magenta() {
        let picked = white_balance_for_sample(WhiteBalance::D65, [0.30, 0.45, 0.30]);
        assert!(picked.tint > 0.0, "green cast needs magenta: {picked:?}");
    }

    #[test]
    fn a_picked_balance_actually_neutralises_the_patch() {
        // The property that matters: applying the answer to the sample should
        // bring its channels together.
        let current = WhiteBalance::D65;
        for sample in [[0.5, 0.3, 0.18], [0.2, 0.3, 0.5], [0.35, 0.3, 0.28]] {
            let picked = white_balance_for_sample(current, sample);
            let gains = white_balance_gains(current, picked);
            let after = [
                sample[0] * gains[0],
                sample[1] * gains[1],
                sample[2] * gains[2],
            ];
            let spread_before = spread(sample);
            let spread_after = spread(after);
            assert!(
                spread_after < spread_before * 0.5,
                "{sample:?} → {after:?} (picked {picked:?})"
            );
        }
    }

    fn spread(rgb: [f32; 3]) -> f32 {
        let max = rgb[0].max(rgb[1]).max(rgb[2]);
        let min = rgb[0].min(rgb[1]).min(rgb[2]);
        (max - min) / max.max(1e-6)
    }

    /// A one-patch scene that answers a temperature change with `strength`
    /// times the gains our model predicts — in log terms, so a strength of 1.5
    /// moves red against blue half again as far per kelvin.
    ///
    /// This is not a hypothetical: measured against real NEFs, Core Image runs
    /// at about 1.5. The point of the seam is that the eyedropper must work
    /// without knowing that number, so the test states a number the solver has
    /// no way to learn.
    struct StrongerThanOurModel {
        patch: [f32; 3],
        reference: WhiteBalance,
        strength: f32,
    }

    impl SceneImage for StrongerThanOurModel {
        fn native_size(&self) -> (u32, u32) {
            (100, 100)
        }

        fn rendering(&self) -> Rendering {
            Rendering::SceneReferred
        }

        fn as_shot(&self) -> WhiteBalance {
            self.reference
        }

        fn neutral_at(
            &self,
            x: f32,
            y: f32,
            current: WhiteBalance,
        ) -> Result<WhiteBalance, SceneError> {
            neutral_by_measurement(self, x, y, current)
        }

        fn render(&self, req: RenderRequest) -> Result<LinearImage, SceneError> {
            let g = white_balance_gains(self.reference, req.white_balance);
            let rgb = (0..3)
                .map(|c| self.patch[c] * g[c].powf(self.strength))
                .collect();
            Ok(LinearImage {
                width: 1,
                height: 1,
                rgb,
            })
        }
    }

    #[test]
    fn the_eyedropper_lands_even_when_the_plugin_disagrees_with_our_model() {
        let reference = WhiteBalance::D65;
        for patch in [[0.5, 0.3, 0.18], [0.18, 0.3, 0.5], [0.34, 0.3, 0.27]] {
            // Core Image measures around 1.5; the others bracket it on both
            // sides, including a plugin weaker than the model rather than
            // stronger, which the same secant step has to handle.
            for strength in [0.6, 1.0, 1.5, 1.9] {
                let scene = StrongerThanOurModel {
                    patch,
                    reference,
                    strength,
                };
                let picked = scene.neutral_at(0.5, 0.5, reference).unwrap();
                let after = scene
                    .render(RenderRequest {
                        max_edge: 1,
                        white_balance: picked,
                        region: Region::FULL,
                    })
                    .unwrap();
                let landed = spread([after.rgb[0], after.rgb[1], after.rgb[2]]);
                // A weak plugin can need a temperature the scale does not go
                // to — neutralising a strongly blue patch at strength 0.6 wants
                // more than 25000 K. Running out of scale is a real answer;
                // stopping short while the scale still has room is not.
                let out_of_range =
                    picked.temperature >= 24999.0 || picked.temperature <= 1668.0;
                assert!(
                    landed < 0.02 || out_of_range,
                    "patch {patch:?} at strength {strength}: still {landed:.3} off neutral \
                     with room left on the scale (picked {picked:?})"
                );
            }
        }
    }

    #[test]
    fn one_solve_alone_would_overshoot_a_stronger_plugin() {
        // The regression this guards: a single pass was what shipped, and on a
        // plugin that moves further than our model it lands past neutral —
        // reversing the cast rather than removing it.
        let reference = WhiteBalance::D65;
        let patch = [0.5, 0.3, 0.18];
        let scene = StrongerThanOurModel {
            patch,
            reference,
            strength: 1.5,
        };
        let once = white_balance_for_sample(reference, patch);
        let single_pass = scene
            .render(RenderRequest {
                max_edge: 1,
                white_balance: once,
                region: Region::FULL,
            })
            .unwrap();
        let before = spread(patch);
        let after_once = spread([
            single_pass.rgb[0],
            single_pass.rgb[1],
            single_pass.rgb[2],
        ]);
        assert!(
            patch[0] / patch[2] > 1.0 && single_pass.rgb[0] / single_pass.rgb[2] < 1.0,
            "a single solve should overshoot past neutral: {before:.3} → {after_once:.3}"
        );
    }

    #[test]
    fn picking_black_or_nonsense_leaves_the_setting_alone() {
        let current = WhiteBalance {
            temperature: 4800.0,
            tint: 3.0,
        };
        assert_eq!(white_balance_for_sample(current, [0.0, 0.0, 0.0]), current);
        assert_eq!(
            white_balance_for_sample(current, [f32::NAN, 0.0, 0.0]),
            current
        );
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
