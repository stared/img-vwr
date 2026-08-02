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

/// The look a raw file gets when nobody has said otherwise.
pub const DEFAULT_FOR_RAW: &str = "nikon";

/// Every preset, in the order a control should cycle through them.
pub fn presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "flat".into(),
            label: "flat".into(),
            note: "The decode as measured, with no look applied.".into(),
            params: DevelopParams::default(),
        },
        Preset {
            id: DEFAULT_FOR_RAW.into(),
            label: "nikon".into(),
            note: "Fitted to the JPEGs this camera makes from the same frames."
                .into(),
            params: DevelopParams {
                exposure: 0.80,
                contrast: 36.0,
                highlights: -22.0,
                shadows: -33.0,
                whites: 68.0,
                blacks: 0.0,
                rolloff: 83.0,
                vibrance: 32.0,
                saturation: 2.0,
            },
        },
    ]
}

pub fn preset(id: &str) -> Option<Preset> {
    presets().into_iter().find(|p| p.id == id)
}

/// The params an untouched image should start from.
///
/// Scene-referred pixels are flat by construction and a camera would have
/// applied a curve before showing them to anyone, so they open with the
/// default look. Anything already rendered opens exactly as it was written —
/// applying a look to a finished JPEG would apply one twice.
pub fn opening_params(rendering: Rendering) -> DevelopParams {
    match rendering {
        Rendering::SceneReferred => preset(DEFAULT_FOR_RAW)
            .map(|p| p.params)
            .unwrap_or_default(),
        Rendering::AlreadyRendered => DevelopParams::default(),
    }
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
    fn raw_opens_with_a_look_and_a_rendered_file_opens_untouched() {
        assert!(!opening_params(Rendering::SceneReferred).is_identity());
        assert!(opening_params(Rendering::AlreadyRendered).is_identity());
    }

    #[test]
    fn a_preset_recognises_itself_and_nothing_else_does() {
        for p in presets() {
            assert_eq!(matching(&p.params).map(|m| m.id), Some(p.id));
        }
        let nudged = DevelopParams {
            exposure: 0.123,
            ..preset(DEFAULT_FOR_RAW).unwrap().params
        };
        assert_eq!(matching(&nudged), None, "a moved slider is no longer a preset");
    }

    #[test]
    fn an_unknown_id_is_not_invented() {
        assert_eq!(preset("kodachrome"), None);
    }
}
