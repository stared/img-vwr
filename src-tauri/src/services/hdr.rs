//! Nothing here writes anywhere: the fused photograph is virtual, its pixels reach disk only through Export.

use imgvwr_core::{SceneError, SceneImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HdrMethod {
    /// Mertens exposure fusion — deliberately no knobs.
    Fusion,
    /// Scene-linear radiance, headroom kept above 1.0; the develop tone controls are the knobs.
    Radiance,
}

pub struct Fusion {
    pub scene: Box<dyn SceneImage>,
    /// Frames that would not align to the pixel, left out rather than ghosted in.
    pub left_out: Vec<String>,
}

/// Frames are turned upright before the merge: the fused photograph has no EXIF of its own to carry the tag.
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

    /// One synthetic bracket frame at `gain` per mille of the base exposure.
    fn frame_jpeg(gain: u32) -> Vec<u8> {
        // Multi-scale blobs, not per-pixel noise: alignment (rightly) refuses pure static.
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
        assert_eq!(fusion.left_out, Vec::<String>::new());
        let scene = fusion.scene;

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