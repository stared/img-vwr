use imgvwr_core::WhiteBalance;
use serde::{Deserialize, Serialize};

/// Zero means unchanged on every slider, so [`Default`] is the identity edit; ranges are ±100 except exposure (stops).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopParams {
    /// Stops of exposure; ±5 EV.
    pub exposure: f32,
    /// S-curve strength around middle grey; ±100.
    pub contrast: f32,
    /// Recovers (negative) or opens up (positive) the bright end; ±100.
    pub highlights: f32,
    /// Lifts (positive) or deepens (negative) the dark end; ±100.
    pub shadows: f32,
    /// Moves the white point; ±100.
    pub whites: f32,
    /// Moves the black point; ±100.
    pub blacks: f32,
    /// How softly the brightest values approach white, 0–100: zero clips at white, above zero bends
    /// the top into an asymptote. One-sided because there is nothing on the other side of clipping.
    pub rolloff: f32,
    /// Saturation weighted towards already-dull colours; ±100.
    pub vibrance: f32,
    /// Flat saturation; ±100.
    pub saturation: f32,
}

impl Default for DevelopParams {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            rolloff: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
        }
    }
}

impl DevelopParams {
    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }

    /// Settings arrive from the frontend and from databases written by older versions; never assumed in range.
    pub fn clamped(&self) -> Self {
        Self {
            exposure: clamp_finite(self.exposure, -5.0, 5.0),
            contrast: clamp_finite(self.contrast, -100.0, 100.0),
            highlights: clamp_finite(self.highlights, -100.0, 100.0),
            shadows: clamp_finite(self.shadows, -100.0, 100.0),
            whites: clamp_finite(self.whites, -100.0, 100.0),
            blacks: clamp_finite(self.blacks, -100.0, 100.0),
            rolloff: clamp_finite(self.rolloff, 0.0, 100.0),
            vibrance: clamp_finite(self.vibrance, -100.0, 100.0),
            saturation: clamp_finite(self.saturation, -100.0, 100.0),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopSettings {
    pub white_balance: WhiteBalance,
    pub params: DevelopParams,
    pub crop: crate::crop::Crop,
    /// The preset this edit was built on — stored, not derived: it cannot be recovered from the
    /// numbers and is what the sliders measure deviation from. An id, so improving a preset
    /// improves everything based on it; an unknown id reads as the identity.
    pub basis: String,
    /// The fitted camera look applied under the sliders; `"flat"` means none.
    /// Defaults independently of `basis`: edits saved before the look existed already emulate it
    /// in slider positions, and applying the look to them too would render twice as strong.
    #[serde(default = "default_look")]
    pub look: String,
}

fn default_look() -> String {
    crate::presets::NONE.to_owned()
}

impl DevelopSettings {
    pub fn neutral(as_shot: WhiteBalance) -> Self {
        Self {
            white_balance: as_shot,
            params: DevelopParams::default(),
            crop: crate::crop::Crop::FULL,
            basis: crate::presets::NONE.to_owned(),
            look: crate::presets::NONE.to_owned(),
        }
    }

    pub fn clamped(&self) -> Self {
        Self {
            white_balance: WhiteBalance {
                temperature: clamp_finite(self.white_balance.temperature, 1667.0, 25000.0),
                tint: clamp_finite(self.white_balance.tint, -150.0, 150.0),
            },
            params: self.params.clamped(),
            crop: self.crop.clamped(),
            basis: self.basis.clone(),
            look: self.look.clone(),
        }
    }
}

fn clamp_finite(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        // NaN has no sensible clamp; fall back to the neutral end of the range.
        if lo <= 0.0 && hi >= 0.0 {
            0.0
        } else {
            lo
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Overlay {
    None,
    /// Tint regions by how much fine detail they resolve — the focus map.
    Sharpness,
    Clipping,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_the_identity_edit() {
        assert!(DevelopParams::default().is_identity());
        assert!(!DevelopParams {
            exposure: 0.5,
            ..Default::default()
        }
        .is_identity());
    }

    #[test]
    fn clamping_bounds_every_slider() {
        let wild = DevelopParams {
            exposure: 99.0,
            contrast: -500.0,
            highlights: 1e9,
            shadows: -1e9,
            whites: 101.0,
            blacks: -101.0,
            rolloff: 150.0,
            vibrance: 200.0,
            saturation: -200.0,
        }
        .clamped();
        assert_eq!(wild.exposure, 5.0);
        assert_eq!(wild.contrast, -100.0);
        assert_eq!(wild.highlights, 100.0);
        assert_eq!(wild.shadows, -100.0);
        assert_eq!(wild.whites, 100.0);
        assert_eq!(wild.blacks, -100.0);
        assert_eq!(wild.rolloff, 100.0);
        assert_eq!(wild.vibrance, 100.0);
        assert_eq!(wild.saturation, -100.0);
    }

    #[test]
    fn clamping_neutralises_non_finite_values() {
        let nan = DevelopParams {
            exposure: f32::NAN,
            contrast: f32::INFINITY,
            ..Default::default()
        }
        .clamped();
        assert_eq!(nan.exposure, 0.0);
        assert_eq!(nan.contrast, 0.0);
    }

    #[test]
    fn settings_clamp_white_balance_into_the_locus() {
        let settings = DevelopSettings {
            white_balance: WhiteBalance {
                temperature: 0.0,
                tint: 900.0,
            },
            params: DevelopParams::default(),
            basis: crate::presets::NONE.to_owned(),
            look: crate::presets::NONE.to_owned(),
            crop: crate::crop::Crop::FULL,
        }
        .clamped();
        assert_eq!(settings.white_balance.temperature, 1667.0);
        assert_eq!(settings.white_balance.tint, 150.0);
    }

    #[test]
    fn neutral_starts_from_the_cameras_choice() {
        let as_shot = WhiteBalance {
            temperature: 5313.0,
            tint: 15.6,
        };
        let settings = DevelopSettings::neutral(as_shot);
        assert_eq!(settings.white_balance, as_shot);
        assert!(settings.params.is_identity());
    }
}
