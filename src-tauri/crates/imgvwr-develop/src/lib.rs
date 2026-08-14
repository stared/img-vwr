//! The develop pipeline, deliberately free of any format knowledge.
//!
//! A [`SceneImage`](imgvwr_core::SceneImage) plugin hands over scene-linear
//! pixels; everything here — exposure, tone, colour, the focus map, the
//! histogram — works the same whether those pixels came from a Nikon NEF or a
//! JPEG. Adding a format means writing a plugin, not touching this crate.

pub mod analysis;
pub mod crop;
pub mod look;
mod look_data;
pub mod params;
pub mod pipeline;
pub mod presets;

pub use analysis::{
    auto_exposure, composite_clipping, composite_sharpness, focus_candidates, focus_point,
    histogram, resolved_detail, sharpness_map, Histogram,
};
pub use crop::Crop;
pub use look::LookTuning;
pub use params::{DevelopParams, DevelopSettings, Overlay};
pub use presets::{baseline, opening_params, opening_settings, preset, presets, Preset};
pub use pipeline::{develop, develop_looked, MID_GREY};

use imgvwr_core::{DecodedImage, Region, RenderRequest, SceneError, SceneImage};

/// One developed frame plus the analysis that describes it.
pub struct Developed {
    pub image: DecodedImage,
    pub histogram: Histogram,
}

/// How big a patch to ask for, so that the crop taken out of it lands at
/// `max_edge`.
///
/// A rotated crop is smaller than the patch containing it, so asking for the
/// patch at `max_edge` would leave the crop short of it — the picture would
/// quietly lose resolution the further it was straightened.
fn patch_edge(crop: &crop::Crop, source: Region, max_edge: u32) -> u32 {
    let crop_longest = crop.width.max(crop.height);
    let patch_longest = source.width.max(source.height);
    if crop_longest <= 0.0 {
        return max_edge;
    }
    let scaled = max_edge as f32 * (patch_longest / crop_longest);
    scaled.ceil().clamp(1.0, u32::MAX as f32) as u32
}

/// Scene-linear pixels for a region of the image the user is looking at.
///
/// Split out from [`render`] because measuring and displaying want the same
/// pixels but not the same treatment: anything that judges a photograph —
/// the exposure it wants, where it is sharp — has to read the light that was
/// recorded, not the eight-bit rendering of it that a tone curve produced.
pub fn render_linear(
    scene: &dyn SceneImage,
    settings: &DevelopSettings,
    max_edge: u32,
    region: Region,
) -> Result<imgvwr_core::LinearImage, SceneError> {
    let native = scene.native_size();
    let aspect = if native.1 == 0 {
        1.0
    } else {
        native.0 as f32 / native.1 as f32
    };

    // `region` is what the viewport wants, expressed in the coordinates of the
    // image the user is looking at — which is already the crop. So the two
    // compose into one smaller crop, rather than rendering the whole crop and
    // throwing most of it away.
    let crop = settings.crop.narrowed(region, aspect);
    if crop.is_full() {
        return scene.render(RenderRequest {
            max_edge,
            white_balance: settings.white_balance,
            region,
        });
    }
    let source = crop.source_region(aspect);
    let patch = scene.render(RenderRequest {
        // A rotated crop needs a patch bigger than itself, so the patch is
        // asked for at whatever resolution leaves the *crop* at max_edge.
        max_edge: patch_edge(&crop, source, max_edge),
        white_balance: settings.white_balance,
        region: source,
    })?;
    if crop.is_axis_aligned() {
        // Nothing to turn: the plugin already rendered exactly the rectangle,
        // and resampling it would only soften it.
        return Ok(patch);
    }
    Ok(crop::resample(
        &patch,
        source,
        &crop,
        aspect,
        crop.output_size(native, max_edge),
    ))
}

/// Render an opened image end to end: plugin render → develop → overlay →
/// histogram. This is the single call the app makes per interaction.
///
/// The histogram is measured *before* an overlay is composited, so it keeps
/// describing the photograph rather than the annotation drawn over it.
pub fn render(
    scene: &dyn SceneImage,
    settings: &DevelopSettings,
    max_edge: u32,
    overlay: Overlay,
    region: Region,
) -> Result<Developed, SceneError> {
    render_looked(scene, settings, max_edge, overlay, region, None)
}

/// [`render`], through the camera look when the settings ask for one and the
/// caller has the image's tuning in hand. The gate is the settings' `look`
/// id, so switching the look off is a settings change like any other.
pub fn render_looked(
    scene: &dyn SceneImage,
    settings: &DevelopSettings,
    max_edge: u32,
    overlay: Overlay,
    region: Region,
    tuning: Option<&LookTuning>,
) -> Result<Developed, SceneError> {
    let settings = settings.clamped();
    let linear = render_linear(scene, &settings, max_edge, region)?;

    let look = if settings.look == presets::DEFAULT_FOR_RAW {
        tuning
    } else {
        None
    };
    let mut image = develop_looked(&linear, &settings.params, look);
    let hist = histogram(&image);

    match overlay {
        Overlay::None => {}
        Overlay::Sharpness => {
            let map = sharpness_map(&linear);
            composite_sharpness(&mut image, &map);
        }
        Overlay::Clipping => composite_clipping(&mut image),
    }

    Ok(Developed {
        image,
        histogram: hist,
    })
}
