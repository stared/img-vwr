pub mod analysis;
pub mod crop;
pub mod look;
mod look_data;
pub mod nr;
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
pub use presets::{
    baseline, is_camera_default, opening_params, opening_settings, preset, presets, Preset, CAMERA,
};
pub use pipeline::{develop, develop_looked, MID_GREY};

use imgvwr_core::{DecodedImage, Region, RenderRequest, SceneError, SceneImage};

pub struct Developed {
    pub image: DecodedImage,
    pub histogram: Histogram,
}

/// Patch size that leaves the crop at `max_edge`: a rotated crop is smaller than the patch
/// containing it, so asking for the patch at max_edge would quietly lose resolution when straightened.
fn patch_edge(crop: &crop::Crop, source: Region, max_edge: u32) -> u32 {
    let crop_longest = crop.width.max(crop.height);
    let patch_longest = source.width.max(source.height);
    if crop_longest <= 0.0 {
        return max_edge;
    }
    let scaled = max_edge as f32 * (patch_longest / crop_longest);
    scaled.ceil().clamp(1.0, u32::MAX as f32) as u32
}

/// Anything that judges the photograph (auto exposure, focus) must read this scene-linear output, never the toned 8-bit rendering.
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

    // `region` is stated in the crop's coordinates, so the two compose into one smaller crop.
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
        max_edge: patch_edge(&crop, source, max_edge),
        white_balance: settings.white_balance,
        region: source,
    })?;
    if crop.is_axis_aligned() {
        // The plugin rendered exactly the rectangle; resampling would only soften it.
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

/// The single call the app makes per interaction. The histogram is measured before the overlay
/// is composited, so it describes the photograph, not the annotation.
pub fn render(
    scene: &dyn SceneImage,
    settings: &DevelopSettings,
    max_edge: u32,
    overlay: Overlay,
    region: Region,
) -> Result<Developed, SceneError> {
    render_looked(scene, settings, max_edge, overlay, region, None)
}

/// [`render`] through the camera look when the settings' `look` id asks for one and tuning is in hand.
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

    // Under the `camera` look, the caller serves the embedded JPEG directly while every knob is
    // untouched; reaching here means a knob moved, and the fitted transform is the closest thing to the label's promise.
    let look = if settings.look == presets::DEFAULT_FOR_RAW || settings.look == presets::CAMERA {
        tuning
    } else {
        None
    };
    // Rendered pixels per native pixel gates the texture-matching NR: at preview scale the downsample averages noise away by itself.
    let (nw, _) = scene.native_size();
    let scale = linear.width as f32 / (nw as f32 * region.width).max(1.0);
    let nr = match look {
        Some(t) if scale >= 0.5 => nr::NrStrength {
            chroma: t.chroma_nr,
            luma: t.luma_nr,
            sharpen: t.sharpen,
        },
        _ => nr::NrStrength::NONE,
    };
    let mut image = pipeline::develop_looked_nr(&linear, &settings.params, look, nr, scale);
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

#[cfg(test)]
mod render_tests {
    use super::*;

    /// The exact-default path serves the camera's embedded JPEG through this call; "exact" requires a finished picture to survive the identity develop byte-for-byte.
    #[test]
    fn a_finished_picture_renders_back_byte_for_byte() {
        let (w, h) = (64u32, 48u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for i in 0..(w * h) {
            // Sweeps all 256 values through all three channels.
            let v = (i % 256) as u8;
            rgba.extend_from_slice(&[v, v.wrapping_add(85), v.wrapping_add(170), 255]);
        }
        let img = image::RgbaImage::from_raw(w, h, rgba.clone()).unwrap();
        let scene = imgvwr_core::image_scene::scene_from_rgba(img);
        let settings =
            opening_settings(
                imgvwr_core::WhiteBalance::D65,
                imgvwr_core::Rendering::AlreadyRendered,
            );
        let developed = render_looked(
            scene.as_ref(),
            &settings,
            w.max(h),
            Overlay::None,
            Region::FULL,
            None,
        )
        .unwrap();
        assert_eq!((developed.image.width, developed.image.height), (w, h));
        let off: Vec<usize> = (0..rgba.len())
            .filter(|&i| developed.image.rgba[i] != rgba[i])
            .take(8)
            .collect();
        assert!(off.is_empty(), "first differing bytes at {off:?}");
    }
}
