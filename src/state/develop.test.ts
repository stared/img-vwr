import { describe, expect, it } from "vitest";

import type { DevelopSettings, DevelopState } from "../ipc";
import { exportName } from "../commands/develop";
import { isNeutral, needsDevelopedFrame, previewEdge, type Session } from "./develop";

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
