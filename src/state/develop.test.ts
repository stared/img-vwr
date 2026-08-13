import { describe, expect, it } from "vitest";

import type { DevelopSettings, DevelopState } from "../ipc";
import {
  baselineOf,
  FULL_CROP,
  isCropped,
  isNeutral,
  loupeCovers,
  LOUPE_MARGIN,
  loupeRegion,
  nextCaption,
  pastedSettings,
  needsDetail,
  needsDevelopedFrame,
  nextPreset,
  PARAM_KEYS,
  PARAM_SPECS,
  presetOf,
  previewEdge,
  regionsDiffer,
  visibleRegion,
  type Session,
} from "./develop";
import type { Preset } from "../ipc";

const asShot = { temperature: 5313.8, tint: 15.6 };

const neutralSettings: DevelopSettings = {
  whiteBalance: asShot,
  params: {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    rolloff: 0,
    vibrance: 0,
    saturation: 0,
  },
  crop: { x: 0, y: 0, width: 1, height: 1, angle: 0 },
  basis: "flat",
};

function session(over: Partial<Session> = {}, info: Partial<DevelopState> = {}): Session {
  return {
    path: "/photos/DSC_0008.NEF",
    info: {
      width: 6048,
      height: 4032,
      asShot,
      settings: neutralSettings,
      edited: false,
      needsRender: false,
      hdr: { kind: "plain" },
      ...info,
    },
    settings: neutralSettings,
    frame: null,
    detail: null,
    detailing: false,
    loupeFrame: null,
    louping: false,
    picking: false,
    overlay: "none",
    rendering: false,
    dirty: false,
    error: null,
    ...over,
  };
}

describe("previewEdge", () => {
  it("scales with the viewport and the display density", () => {
    expect(previewEdge(1000, 2)).toBe(2000);
    expect(previewEdge(1000, 1)).toBe(1200); // floor
  });

  it("stays within bounds so a huge window cannot force a full-res render", () => {
    expect(previewEdge(4000, 2)).toBe(3000);
    expect(previewEdge(100, 1)).toBe(1200);
  });
});

describe("isNeutral", () => {
  it("is true for an untouched image at its as-shot white balance", () => {
    expect(isNeutral(session())).toBe(true);
  });

  it("notices any moved slider", () => {
    const edited = session({
      settings: { ...neutralSettings, params: { ...neutralSettings.params, exposure: 0.3 } },
    });
    expect(isNeutral(edited)).toBe(false);
  });

  it("notices a white balance moved away from as shot", () => {
    const warmed = session({
      settings: { ...neutralSettings, whiteBalance: { temperature: 7000, tint: 15.6 } },
    });
    expect(isNeutral(warmed)).toBe(false);
  });

  it("treats the camera's own temperature as neutral, not 6500 K", () => {
    // The starting point is what the camera chose; an image at 5313 K with
    // nothing touched is unedited, and must not render as "edited".
    expect(isNeutral(session())).toBe(true);
  });
});

describe("needsDevelopedFrame", () => {
  it("is false with no session at all", () => {
    expect(needsDevelopedFrame(null)).toBe(false);
  });

  it("is true for a format the webview cannot decode, even unedited", () => {
    expect(needsDevelopedFrame(session({}, { needsRender: true }))).toBe(true);
  });

  it("is false for an untouched JPEG, which the webview shows directly", () => {
    expect(needsDevelopedFrame(session())).toBe(false);
  });

  it("becomes true for a JPEG once it is edited", () => {
    const edited = session({
      settings: { ...neutralSettings, params: { ...neutralSettings.params, contrast: 20 } },
    });
    expect(needsDevelopedFrame(edited)).toBe(true);
  });

  it("becomes true for a JPEG once it is cropped, sliders untouched", () => {
    // The regression: a crop is the one edit outside the params, and a
    // cropped photograph shown as its whole file is the crop silently not
    // applying. Finishing a crop must switch to the developed frame.
    const cropped = session({
      settings: {
        ...neutralSettings,
        crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, angle: 0 },
      },
    });
    expect(needsDevelopedFrame(cropped)).toBe(true);
    // A straighten alone changes the pixels just as surely.
    const turned = session({
      settings: { ...neutralSettings, crop: { x: 0, y: 0, width: 1, height: 1, angle: 1.5 } },
    });
    expect(needsDevelopedFrame(turned)).toBe(true);
  });
});

describe("visibleRegion", () => {
  const image = { width: 6000, height: 4000 };

  it("is the whole frame when the image fits the canvas", () => {
    // Fitted: scale puts the full width in the canvas.
    const view = { scale: 1000 / 6000, tx: 0, ty: 0 };
    const region = visibleRegion(view, image, { width: 1000, height: 667 });
    expect(region.x).toBeCloseTo(0);
    expect(region.width).toBeCloseTo(1);
  });

  it("narrows to what is on screen when zoomed in", () => {
    // 1:1 on a 1000px canvas shows a sixth of a 6000px-wide image.
    const view = { scale: 1, tx: 0, ty: 0 };
    const region = visibleRegion(view, image, { width: 1000, height: 500 });
    expect(region.width).toBeCloseTo(1 / 6);
    expect(region.height).toBeCloseTo(1 / 8);
  });

  it("follows the pan offset", () => {
    const view = { scale: 1, tx: -3000, ty: -2000 };
    const region = visibleRegion(view, image, { width: 1000, height: 500 });
    expect(region.x).toBeCloseTo(0.5);
    expect(region.y).toBeCloseTo(0.5);
  });

  it("never runs past the edge of the image", () => {
    const view = { scale: 1, tx: -5800, ty: -3900 };
    const region = visibleRegion(view, image, { width: 1000, height: 500 });
    expect(region.x + region.width).toBeLessThanOrEqual(1.0001);
    expect(region.y + region.height).toBeLessThanOrEqual(1.0001);
  });

  it("degrades to the full frame rather than dividing by zero", () => {
    expect(visibleRegion({ scale: 0, tx: 0, ty: 0 }, image, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("needsDetail", () => {
  const image = { width: 6000 };

  it("is false while the preview still out-resolves the screen", () => {
    // A 3000px preview of a 6000px image resolves down to scale 0.5.
    expect(needsDetail({ scale: 0.2 }, { width: 3000 }, image)).toBe(false);
    expect(needsDetail({ scale: 0.5 }, { width: 3000 }, image)).toBe(false);
  });

  it("is true once the preview is being magnified", () => {
    expect(needsDetail({ scale: 1 }, { width: 3000 }, image)).toBe(true);
  });

  it("is false for a degenerate frame or image", () => {
    expect(needsDetail({ scale: 4 }, { width: 0 }, image)).toBe(false);
    expect(needsDetail({ scale: 4 }, { width: 100 }, { width: 0 })).toBe(false);
  });
});

describe("regionsDiffer", () => {
  const base = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };

  it("ignores sub-percent drift, so panning does not thrash the renderer", () => {
    expect(regionsDiffer(base, { ...base, x: 0.205 })).toBe(false);
  });

  it("notices a real move", () => {
    expect(regionsDiffer(base, { ...base, x: 0.4 })).toBe(true);
    expect(regionsDiffer(base, { ...base, width: 0.5 })).toBe(true);
  });
});

describe("presets", () => {
  const flat: Preset = {
    id: "flat",
    label: "flat",
    note: "no look",
    params: neutralSettings.params,
  };
  const nikon: Preset = {
    id: "nikon",
    label: "nikon",
    note: "camera look",
    params: { ...neutralSettings.params, exposure: 0.8, contrast: 36, rolloff: 83 },
  };
  const catalog = [flat, nikon];

  it("names the preset the sliders are currently sitting on", () => {
    expect(presetOf(nikon.params, catalog)?.id).toBe("nikon");
    expect(presetOf(flat.params, catalog)?.id).toBe("flat");
  });

  it("names nothing once a slider has moved off one", () => {
    expect(presetOf({ ...nikon.params, shadows: -12 }, catalog)).toBeNull();
  });

  it("cycles through the catalog from a preset", () => {
    expect(nextPreset(flat, flat, catalog)?.id).toBe("nikon");
    expect(nextPreset(nikon, nikon, catalog)?.id).toBe("flat");
  });

  it("goes back to the basis from an edited state, not on round the cycle", () => {
    // Having tweaked nikon, the useful click is undoing the tweaks.
    expect(nextPreset(null, nikon, catalog)?.id).toBe("nikon");
  });

  it("has nothing to move to when the catalog has not arrived", () => {
    expect(nextPreset(null, null, [])).toBeNull();
  });

  it("measures deviation from the stored basis, and holds it as sliders move", () => {
    const edited = { ...neutralSettings, params: { ...nikon.params, exposure: 1.4 }, basis: "nikon" };
    expect(baselineOf(edited, catalog)?.id).toBe("nikon");
  });

  it("takes the preset it is sitting on as the baseline, whatever the basis says", () => {
    const landed = { ...neutralSettings, params: flat.params, basis: "nikon" };
    expect(baselineOf(landed, catalog)?.id).toBe("flat");
  });

  it("has no baseline when the basis names a preset that is gone", () => {
    const orphan = { ...neutralSettings, params: { ...nikon.params, exposure: 1.4 }, basis: "kodachrome" };
    expect(baselineOf(orphan, catalog)).toBeNull();
  });
});

describe("the slider list", () => {
  // Two lists that have to agree: one drives the panel, the other drives every
  // comparison against a preset. A slider present in one and not the other
  // would be invisible to exactly one of them.
  it("covers every parameter exactly once", () => {
    expect(PARAM_SPECS.map((s) => s.key)).toEqual([...PARAM_KEYS]);
  });

  it("gives every slider a range that contains its neutral value", () => {
    for (const spec of PARAM_SPECS) {
      expect(spec.min).toBeLessThan(spec.max);
      expect(spec.min).toBeLessThanOrEqual(0);
      expect(spec.max).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("pastedSettings", () => {
  const copied = {
    ...neutralSettings,
    whiteBalance: { temperature: 7800, tint: 12 },
    params: { ...neutralSettings.params, exposure: 1.4, contrast: 36 },
    basis: "nikon",
  };
  const target = {
    ...neutralSettings,
    whiteBalance: { temperature: 4200, tint: -6 },
    params: neutralSettings.params,
    basis: "flat",
  };

  it("carries the look, and the basis it is a variation of", () => {
    // "nikon plus a bit of exposure" must land as the same variation of
    // nikon, not as a bare set of numbers sitting on top of flat.
    const pasted = pastedSettings(target, copied);
    expect(pasted.params).toEqual(copied.params);
    expect(pasted.basis).toBe("nikon");
  });

  it("leaves the white balance where it was", () => {
    // The two frames were shot under different light; the copied reading
    // describes the other one.
    expect(pastedSettings(target, copied).whiteBalance).toEqual(target.whiteBalance);
  });
});

describe("isCropped", () => {
  it("is false for the whole frame and true for anything else", () => {
    expect(isCropped(FULL_CROP)).toBe(false);
    expect(isCropped({ ...FULL_CROP, width: 0.5 })).toBe(true);
    // Straightening alone is a crop: the frame is turned even if nothing was
    // trimmed, and the button that puts it back has to appear.
    expect(isCropped({ ...FULL_CROP, angle: 2 })).toBe(true);
  });
});

describe("loupeRegion", () => {
  const frame = { width: 6048, height: 4032 };

  it("covers exactly as much of the image as fits at 1:1", () => {
    // 440 device pixels of a 6048 px frame is a small square of it — that is
    // what "one image pixel per device pixel" means.
    const region = loupeRegion({ x: 0.5, y: 0.5 }, frame, 440);
    expect(region.width).toBeCloseTo(440 / 6048, 6);
    expect(region.height).toBeCloseTo(440 / 4032, 6);
  });

  it("centres on the point it is aimed at", () => {
    const region = loupeRegion({ x: 0.5, y: 0.5 }, frame, 440);
    expect(region.x + region.width / 2).toBeCloseTo(0.5, 6);
    expect(region.y + region.height / 2).toBeCloseTo(0.5, 6);
  });

  it("shows the corner rather than half a box of nothing", () => {
    const corner = loupeRegion({ x: 0, y: 0 }, frame, 440);
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0);
    const far = loupeRegion({ x: 1, y: 1 }, frame, 440);
    expect(far.x + far.width).toBeCloseTo(1, 6);
    expect(far.y + far.height).toBeCloseTo(1, 6);
  });

  it("shows the whole of an image smaller than the loupe", () => {
    const tiny = loupeRegion({ x: 0.5, y: 0.5 }, { width: 100, height: 80 }, 440);
    expect(tiny).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("the loupe's margin is what makes moving it smooth", () => {
  const frame = { width: 6048, height: 4032 };
  const WINDOW = 440;
  /** What is developed when the loupe is aimed at `at`. */
  const developed = (at: { x: number; y: number }) =>
    loupeRegion(at, frame, Math.round(WINDOW * LOUPE_MARGIN));
  /** What the window needs to fill itself, aimed at `at`. */
  const wanted = (at: { x: number; y: number }) => loupeRegion(at, frame, WINDOW);

  it("develops more than the window shows", () => {
    expect(developed({ x: 0.5, y: 0.5 }).width).toBeGreaterThan(wanted({ x: 0.5, y: 0.5 }).width);
  });

  it("covers the small movements that aiming is mostly made of", () => {
    const have = developed({ x: 0.5, y: 0.5 });
    // A nudge of a third of the window: no render, the window just slides.
    const nudge = wanted({ x: 0.5 + WINDOW / 3 / frame.width, y: 0.5 });
    expect(loupeCovers(have, nudge)).toBe(true);
  });

  it("asks for more once the aim has left the pixels in hand", () => {
    const have = developed({ x: 0.5, y: 0.5 });
    expect(loupeCovers(have, wanted({ x: 0.75, y: 0.5 }))).toBe(false);
    expect(loupeCovers(have, wanted({ x: 0.5, y: 0.9 }))).toBe(false);
  });

  it("counts a window at the frame's edge as covered", () => {
    // Both regions clamp to the same corner, so the pixels really are there —
    // and an off-by-a-float here would re-render on every drag in the corner.
    expect(loupeCovers(developed({ x: 0, y: 0 }), wanted({ x: 0, y: 0 }))).toBe(true);
    expect(loupeCovers(developed({ x: 1, y: 1 }), wanted({ x: 1, y: 1 }))).toBe(true);
  });
});

describe("nextCaption", () => {
  it("reaches every state and comes back", () => {
    expect(nextCaption("briefly")).toBe("always");
    expect(nextCaption("always")).toBe("off");
    expect(nextCaption("off")).toBe("briefly");
  });
});
