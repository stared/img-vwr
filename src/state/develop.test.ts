import { describe, expect, it } from "vitest";

import type { DevelopSettings, DevelopState } from "../ipc";
import { exportName } from "../commands/develop";
import {
  isNeutral,
  needsDetail,
  needsDevelopedFrame,
  previewEdge,
  regionsDiffer,
  visibleRegion,
  type Session,
} from "./develop";

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
    vibrance: 0,
    saturation: 0,
  },
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
      ...info,
    },
    settings: neutralSettings,
    frame: null,
    detail: null,
    detailing: false,
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
});

describe("exportName", () => {
  it("keeps the stem and swaps the extension", () => {
    expect(exportName("/photos/DSC_0008.NEF", "jpg")).toBe("DSC_0008.jpg");
    expect(exportName("/photos/holiday.jpeg", "png")).toBe("holiday.png");
  });

  it("copes with a name that has no extension", () => {
    expect(exportName("/photos/scan", "jpg")).toBe("scan.jpg");
  });

  it("copes with dots inside the name", () => {
    expect(exportName("/photos/2026.08.02 walk.NEF", "jpg")).toBe("2026.08.02 walk.jpg");
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
