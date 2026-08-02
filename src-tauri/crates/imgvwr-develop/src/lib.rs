//! The develop pipeline, deliberately free of any format knowledge.
//!
//! A [`SceneImage`](imgvwr_core::SceneImage) plugin hands over scene-linear
//! pixels; everything here — exposure, tone, colour, the focus map, the
//! histogram — works the same whether those pixels came from a Nikon NEF or a
//! JPEG. Adding a format means writing a plugin, not touching this crate.

pub mod analysis;
pub mod params;
pub mod pipeline;
pub mod presets;

pub use analysis::{composite_sharpness, histogram, sharpness_map, Histogram};
pub use params::{DevelopParams, DevelopSettings, Overlay};
pub use presets::{opening_params, preset, presets, Preset};
pub use pipeline::{develop, MID_GREY};

use imgvwr_core::{DecodedImage, Region, RenderRequest, SceneError, SceneImage};

/// One developed frame plus the analysis that describes it.
pub struct Developed {
    pub image: DecodedImage,
    pub histogram: Histogram,
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
    let settings = settings.clamped();
    let linear = scene.render(RenderRequest {
        max_edge,
        white_balance: settings.white_balance,
        region,
    })?;

    let mut image = develop(&linear, &settings.params);
    let hist = histogram(&image);

    match overlay {
        Overlay::None => {}
        Overlay::Sharpness => {
            let map = sharpness_map(&linear);
            composite_sharpness(&mut image, &map);
        }
    }

    Ok(Developed {
        image,
        histogram: hist,
    })
}
