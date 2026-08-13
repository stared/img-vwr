//! Opening an exposure bracket as one photograph.
//!
//! The compute lives in `imgvwr-hdr`; this module turns a list of frame
//! files into a [`SceneImage`] the develop pipeline can treat like any
//! other. Nothing here writes anywhere: the fused photograph is *virtual* —
//! it exists behind its face frame's path, edits on it live in `develop.db`
//! under that path like every other edit, and its pixels only reach disk
//! through Export, like every other photograph's.

use imgvwr_core::{SceneError, SceneImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// How a bracket becomes one photograph. An enum, because the choices are
/// few and each is a different *kind* of result — not a parameter sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HdrMethod {
    /// Mertens exposure fusion: a blend of the best-exposed pixels. Looks
    /// like the camera's pictures; deliberately has no knobs.
    Fusion,
    /// Scene-linear radiance: the light itself, with the darker exposures'
    /// headroom kept above 1.0. The develop pipeline's tone controls are
    /// the knobs — this is the "professional HDR" path.
    Radiance,
}

/// What a fusion produced: the scene, and how much of the bracket is in it.
pub struct Fusion {
    pub scene: Box<dyn SceneImage>,
    /// The frames that could not be aligned to the pixel and were left out
    /// rather than ghosted in. Alignment is per frame, and the panel names
    /// the casualties instead of rounding the set up to "fused".
    pub left_out: Vec<String>,
}

/// Decode these frames — one bracket, the caller decided — align them,
/// merge them by `method`, and hand back the result as a scene.
///
/// Each frame is turned upright before the merge: orientation is a property
/// of the files, and the fused photograph is not a file — it has no EXIF of
/// its own to carry the tag, so its pixels must already be the right way up.
pub fn fused_scene(paths: &[String], method: HdrMethod) -> Result<Fusion, SceneError> {
    let frames: Vec<image::RgbImage> = paths
        .par_iter()
        .map(|path| {
            let bytes =
                std::fs::read(path).map_err(|e| SceneError::Open(format!("{path}: {e}")))?;
            let decoded = image::load_from_memory(&bytes)
                .map_err(|e| SceneError::Open(format!("{path}: {e}")))?
                .into_rgba8();
            let upright =
                imgvwr_core::thumbs::apply_orientation(decoded, imgvwr_core::thumbs::exif_orientation(&bytes));
            Ok(image::DynamicImage::ImageRgba8(upright).into_rgb8())
        })
        .collect::<Result<_, SceneError>>()?;

    let (scene, motions) = match method {
        HdrMethod::Fusion => {
            let merged = imgvwr_hdr::merge(&frames).map_err(SceneError::Open)?;
            let scene = imgvwr_core::scene_from_rgba(
                image::DynamicImage::ImageRgb8(merged.image).into_rgba8(),
            );
            (scene, merged.motions)
        }
        HdrMethod::Radiance => {
            let merged = imgvwr_hdr::merge_radiance(&frames).map_err(SceneError::Open)?;
            let scene = imgvwr_core::scene_from_radiance(merged.width, merged.height, merged.rgb);
            (scene, merged.motions)
        }
    };
    let left_out = motions
        .iter()
        .zip(paths)
        .filter(|(motion, _)| motion.is_none())
        .map(|(_, path)| path.clone())
        .collect();
    Ok(Fusion { scene, left_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One frame of a synthetic bracket: a red block on textured ground, at
    /// `gain` per mille of the base exposure.
    fn frame_jpeg(gain: u32) -> Vec<u8> {
        // Multi-scale blobs, not per-pixel noise: verified alignment
        // rightly refuses a "scene" that is pure static.
        let noise = |gx: u32, gy: u32, salt: u32| -> i32 {
            (gx.wrapping_mul(2654435761) ^ gy.wrapping_mul(40503) ^ salt.wrapping_mul(97)) as i32
                % 61
                - 30
        };
        let img = image::RgbImage::from_fn(96, 64, |x, y| {
            let (r, g, b) = if x > 30 && x < 60 && y > 20 && y < 44 {
                (200, 60, 40)
            } else {
                let v =
                    (90 + noise(x / 12, y / 12, 1) + noise(x / 3, y / 3, 2)).clamp(0, 255) as u32;
                (v, v, v)
            };
            let expose = |c: u32| (c * gain / 1000).min(255) as u8;
            image::Rgb([expose(r), expose(g), expose(b)])
        });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .encode_image(&img)
            .unwrap();
        out
    }

    #[test]
    fn a_bracket_on_disk_opens_as_one_scene_and_the_files_stay_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for (i, gain) in [250u32, 1000, 4000].iter().enumerate() {
            let path = dir.path().join(format!("DSC_000{i}.JPG"));
            std::fs::write(&path, frame_jpeg(*gain)).unwrap();
            paths.push(path.display().to_string());
        }

        let fusion = fused_scene(&paths, HdrMethod::Fusion).unwrap();
        // Every frame made it in, and the caller is told so.
        assert_eq!(fusion.left_out, Vec::<String>::new());
        let scene = fusion.scene;

        // The same bracket as radiance: a scene-referred image the develop
        // pipeline will choose a look for — the sliders become HDR knobs.
        let radiant = fused_scene(&paths, HdrMethod::Radiance).unwrap();
        assert_eq!(radiant.scene.native_size(), (96, 64));
        assert_eq!(
            radiant.scene.rendering(),
            imgvwr_core::Rendering::SceneReferred,
            "radiance is light, not a finished picture"
        );
        // Identical framing in, identical framing out — nothing was cropped.
        assert_eq!(scene.native_size(), (96, 64));
        let rendered = scene
            .render(imgvwr_core::RenderRequest {
                max_edge: 96,
                white_balance: imgvwr_core::WhiteBalance::D65,
                region: imgvwr_core::Region::FULL,
            })
            .unwrap();
        assert_eq!((rendered.width, rendered.height), (96, 64));

        // The folder holds exactly what it held: a virtual merge writes nothing.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
        assert_eq!(std::fs::read(&paths[1]).unwrap(), frame_jpeg(1000));
    }

    #[test]
    fn a_missing_frame_fails_the_open_with_its_name_in_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("DSC_0020.JPG");
        std::fs::write(&real, frame_jpeg(1000)).unwrap();
        let missing = dir.path().join("DSC_0021.JPG");

        let result = fused_scene(
            &[real.display().to_string(), missing.display().to_string()],
            HdrMethod::Fusion,
        );
        let error = format!("{:?}", result.err().expect("must fail"));
        assert!(error.contains("DSC_0021"), "{error}");
    }
}