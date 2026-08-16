//! Named starting points for an edit.
//!
//! A preset is nothing but a [`DevelopParams`] with a name, which is the point:
//! applying one leaves every slider exactly where the user can see it and move
//! it. Nothing here is a mode, and nothing is hidden — pick a preset, then
//! disagree with it.
//!
//! ## Where the numbers come from
//!
//! Not taste. The camera writes a JPEG beside every raw frame, so "what would
//! the camera have done with this" is a measurable question, and the settings
//! below are the answer to it: the single edit that minimises the mean
//! difference from the camera's own rendering across 52 matched pairs, found
//! by `cargo run --release -p imgvwr-develop --example match_camera`.
//!
//! That example also reports the ceiling — the best any tone curve could do,
//! measured with a free lookup table rather than assumed. Worth re-reading
//! before changing these: it says how much room is actually left.

use imgvwr_core::Rendering;
use serde::{Deserialize, Serialize};

use crate::params::DevelopParams;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    /// What the control says when this preset is the one in effect.
    pub label: String,
    /// One line on what it does, for the panel to show beneath.
    pub note: String,
    pub params: DevelopParams,
}

/// The look a raw file opens under: the camera's own JPEG, shown as-is
/// while every knob is untouched, with the fitted transform standing in
/// the moment one moves. Named in the preset row — a state the panel says
/// out loud, never a silent substitution.
pub const CAMERA: &str = "camera";

/// The fitted camera transform.
pub const DEFAULT_FOR_RAW: &str = "nikon";

/// The identity preset: no look, and the baseline everything measures against
/// when it has no other one.
pub const NONE: &str = "flat";

/// Every preset, in the order a control should cycle through them.
pub fn presets() -> Vec<Preset> {
    vec![
        Preset {
            id: CAMERA.into(),
            label: "camera jpeg".into(),
            note: "The JPEG the camera itself wrote for this frame, shown \
                   as-is while nothing is edited. The first moved slider \
                   develops the raw instead, through the fitted look."
                .into(),
            params: DevelopParams::default(),
        },
        Preset {
            id: DEFAULT_FOR_RAW.into(),
            label: "nikon".into(),
            note: "The camera's own rendering, fitted to the JPEGs it makes \
                   from the same frames."
                .into(),
            // The look is not slider positions any more: it is the fitted
            // camera transform (see `crate::look`), selected by
            // `DevelopSettings::look` carrying this id. The sliders stay at
            // zero so every one of them still means "as the camera would".
            params: DevelopParams::default(),
        },
        Preset {
            id: NONE.into(),
            label: "flat".into(),
            note: "The decode as measured, with no look applied.".into(),
            params: DevelopParams::default(),
        },
    ]
}

pub fn preset(id: &str) -> Option<Preset> {
    presets().into_iter().find(|p| p.id == id)
}

/// Which preset an untouched image of this kind should open on.
///
/// Scene-referred pixels are flat by construction and a camera would have
/// applied a curve before showing them to anyone, so they open showing the
/// camera's own picture. Anything already rendered opens exactly as it was
/// written — applying a look to a finished JPEG would apply one twice.
pub fn opening_preset(rendering: Rendering) -> &'static str {
    match rendering {
        Rendering::SceneReferred => CAMERA,
        Rendering::AlreadyRendered => NONE,
    }
}

/// The params an untouched image should start from.
pub fn opening_params(rendering: Rendering) -> DevelopParams {
    preset(opening_preset(rendering))
        .map(|p| p.params)
        .unwrap_or_default()
}

/// The whole opening state, look and basis together, for an image whose camera
/// chose `as_shot`.
pub fn opening_settings(
    as_shot: imgvwr_core::WhiteBalance,
    rendering: Rendering,
) -> crate::params::DevelopSettings {
    crate::params::DevelopSettings {
        white_balance: as_shot,
        params: opening_params(rendering),
        crop: crate::crop::Crop::FULL,
        basis: opening_preset(rendering).to_owned(),
        look: opening_preset(rendering).to_owned(),
    }
}

/// Whether these settings can honestly show the camera's own JPEG: the
/// `camera` look, every slider at zero, the as-shot balance, the full
/// frame. The look names the state in the preset row; this predicate says
/// when the promise can still be kept. The first touched knob leaves it,
/// and the render develops the raw through the fitted look instead — with
/// the frame reporting which of the two it served.
pub fn is_camera_default(
    settings: &crate::params::DevelopSettings,
    as_shot: imgvwr_core::WhiteBalance,
    rendering: Rendering,
) -> bool {
    if rendering != Rendering::SceneReferred {
        return false;
    }
    // The balance round-trips through the database as text; compare to the
    // precision a slider can express, not bit-for-bit.
    let wb_untouched = (settings.white_balance.temperature - as_shot.temperature).abs() < 0.5
        && (settings.white_balance.tint - as_shot.tint).abs() < 0.5;
    settings.look == CAMERA
        && settings.params == opening_params(rendering)
        && settings.crop == crate::crop::Crop::FULL
        && wb_untouched
}

/// The params a set of settings measures its deviation from.
///
/// Sitting exactly on some preset makes that one the baseline, whatever the
/// stored basis says — otherwise the sliders would show a deviation from one
/// preset while the panel named another.
pub fn baseline(settings: &crate::params::DevelopSettings) -> DevelopParams {
    matching(&settings.params)
        .or_else(|| preset(&settings.basis))
        .map(|p| p.params)
        .unwrap_or_default()
}

/// Which preset these settings are, if they are still exactly one of them.
///
/// Compared rather than remembered: a stored session has no note of which
/// preset it came from, and a remembered name would go stale the moment a
/// slider moved. This way the control can only ever name a preset the image
/// actually matches.
pub fn matching(params: &DevelopParams) -> Option<Preset> {
    presets().into_iter().find(|p| p.params == *params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_default_holds_until_any_knob_moves() {
        let as_shot = imgvwr_core::WhiteBalance {
            temperature: 5099.3,
            tint: 17.2,
        };
        let opening = opening_settings(as_shot, Rendering::SceneReferred);
        assert!(is_camera_default(&opening, as_shot, Rendering::SceneReferred));

        // Tiny storage round-trip wobble on the balance is still default.
        let mut wobbled = opening.clone();
        wobbled.white_balance.temperature += 0.2;
        assert!(is_camera_default(&wobbled, as_shot, Rendering::SceneReferred));

        // Any real edit leaves the state: a slider, the balance, the crop,
        // the look itself.
        let mut edited = opening.clone();
        edited.params.exposure = 0.1;
        assert!(!is_camera_default(&edited, as_shot, Rendering::SceneReferred));
        let mut warmed = opening.clone();
        warmed.white_balance.temperature += 100.0;
        assert!(!is_camera_default(&warmed, as_shot, Rendering::SceneReferred));
        let mut cropped = opening.clone();
        cropped.crop.width = 0.5;
        assert!(!is_camera_default(&cropped, as_shot, Rendering::SceneReferred));
        let mut flat = opening.clone();
        flat.look = NONE.to_owned();
        assert!(!is_camera_default(&flat, as_shot, Rendering::SceneReferred));
        // The fitted look is a different, deliberate choice — not this state.
        let mut fitted = opening.clone();
        fitted.look = DEFAULT_FOR_RAW.to_owned();
        assert!(!is_camera_default(&fitted, as_shot, Rendering::SceneReferred));

        // A JPEG never has a camera default to fall back to — it IS one.
        assert!(!is_camera_default(
            &opening_settings(as_shot, Rendering::AlreadyRendered),
            as_shot,
            Rendering::AlreadyRendered
        ));
    }

    #[test]
    fn every_preset_has_a_distinct_id_and_survives_clamping() {
        let all = presets();
        for p in &all {
            assert_eq!(all.iter().filter(|q| q.id == p.id).count(), 1, "{}", p.id);
            assert_eq!(
                p.params.clamped(),
                p.params,
                "{} is outside the slider ranges",
                p.id
            );
        }
    }

    #[test]
    fn flat_is_the_identity_edit() {
        assert!(preset("flat").unwrap().params.is_identity());
    }

    #[test]
    fn raw_opens_with_the_camera_look_and_a_rendered_file_without_one() {
        // The look moved out of the sliders: every preset opens with them at
        // zero, and what distinguishes a raw is the look id it opens under.
        assert!(opening_params(Rendering::SceneReferred).is_identity());
        assert!(opening_params(Rendering::AlreadyRendered).is_identity());
        let raw = opening_settings(imgvwr_core::WhiteBalance::D65, Rendering::SceneReferred);
        assert_eq!(raw.look, CAMERA);
        let jpeg = opening_settings(imgvwr_core::WhiteBalance::D65, Rendering::AlreadyRendered);
        assert_eq!(jpeg.look, NONE);
    }

    #[test]
    fn matching_by_params_lands_on_the_first_preset_with_those_sliders() {
        // Every preset now shares the identity sliders, so params alone name
        // the first of them; which look is on is `DevelopSettings::look`'s
        // question, not the sliders'.
        assert_eq!(matching(&DevelopParams::default()).map(|m| m.id), Some(CAMERA.to_owned()));
        let nudged = DevelopParams {
            exposure: 0.123,
            ..DevelopParams::default()
        };
        assert_eq!(matching(&nudged), None, "a moved slider is no longer a preset");
    }

    #[test]
    fn the_baseline_is_what_the_sliders_measure_against() {
        use crate::params::DevelopSettings;
        let nikon = preset(DEFAULT_FOR_RAW).unwrap();
        let as_shot = imgvwr_core::WhiteBalance::D65;

        // Untouched raw: the baseline is the look it opened with, so every
        // slider reads as unmoved even though none of them is at zero.
        let opened = opening_settings(as_shot, Rendering::SceneReferred);
        assert_eq!(baseline(&opened), nikon.params);
        assert_eq!(opened.basis, CAMERA);

        // Nudged off it: the baseline stays put, which is the whole point —
        // otherwise the deviation would follow the value and always be zero.
        let nudged = DevelopSettings {
            params: DevelopParams { exposure: 1.4, ..nikon.params },
            ..opened.clone()
        };
        assert_eq!(baseline(&nudged), nikon.params);

        // Landing exactly on another preset makes that one the baseline,
        // whatever the stored basis says, so the panel and the sliders cannot
        // name different things.
        let flattened = DevelopSettings {
            params: DevelopParams::default(),
            ..opened.clone()
        };
        assert_eq!(baseline(&flattened), DevelopParams::default());

        // A basis naming a preset that no longer exists degrades to identity
        // rather than to nothing at all.
        let orphaned = DevelopSettings {
            params: DevelopParams { exposure: 1.4, ..nikon.params },
            basis: "kodachrome".into(),
            ..opened
        };
        assert_eq!(baseline(&orphaned), DevelopParams::default());
    }

    #[test]
    fn an_unknown_id_is_not_invented() {
        assert_eq!(preset("kodachrome"), None);
    }
}
