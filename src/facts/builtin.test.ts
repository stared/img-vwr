import { beforeAll, describe, expect, it } from "vitest";

import { clearFactsForTest, factLines } from "../registry/facts";
import type { FileEntry, ImageMeta } from "../ipc";
import { DEFAULT_OVERLAY_FACTS, formatAperture, formatShutter, registerBuiltinFacts } from "./builtin";

const entry: FileEntry = {
  path: "/p/DSC_0178.NEF",
  name: "DSC_0178.NEF",
  size: 25_000_000,
  modifiedMs: 0,
  formatHint: "nef",
};

const EXIF = {
  orientation: 1,
  dateTime: "2026-08-04 14:36:10",
  camera: "NIKON Z6_3",
  lens: "NIKKOR Z 50mm f/1.8 S",
  exposureTime: 0.005,
  fNumber: 1.8,
  iso: 4000,
  focalLength: 50,
  exposureBias: 0,
  gpsLat: null,
  gpsLon: null,
};

const shot: ImageMeta = {
  width: 6048,
  height: 4032,
  format: "nef",
  fileSize: 25_000_000,
  modifiedMs: 0,
  exif: EXIF,
  grade: null,
};

beforeAll(() => {
  clearFactsForTest();
  registerBuiltinFacts();
});

describe("formatShutter", () => {
  it("says the reciprocal below a second, as a camera dial does", () => {
    expect(formatShutter(0.005)).toBe("1/200");
    expect(formatShutter(1 / 8000)).toBe("1/8000");
    // Rounded: no camera has ever claimed 1/199.8.
    expect(formatShutter(0.005012)).toBe("1/200");
  });

  it("says seconds at and above one, with the inch mark", () => {
    expect(formatShutter(1)).toBe('1"');
    expect(formatShutter(1.6)).toBe('1.6"');
    expect(formatShutter(30)).toBe('30"');
  });

  it("says nothing about a nonsense exposure", () => {
    expect(formatShutter(0)).toBe("");
    expect(formatShutter(-1)).toBe("");
    expect(formatShutter(Number.NaN)).toBe("");
  });
});

describe("formatAperture", () => {
  it("drops the decimal nobody says out loud", () => {
    expect(formatAperture(8)).toBe("f/8");
    expect(formatAperture(1.8)).toBe("f/1.8");
    expect(formatAperture(0)).toBe("");
  });
});

describe("factLines", () => {
  it("groups a fully tagged photograph the way a caption reads", () => {
    const lines = factLines(DEFAULT_OVERLAY_FACTS, { entry, meta: shot, asShot: null });
    expect(lines.map((l) => l.group)).toEqual(["identity", "camera", "exposure"]);
    expect(lines[0]?.parts).toEqual(["DSC_0178.NEF"]);
    expect(lines[1]?.parts).toEqual(["NIKON Z6_3", "NIKKOR Z 50mm f/1.8 S"]);
    expect(lines[2]?.parts).toEqual(["50 mm", "1/200", "f/1.8", "ISO 4000"]);
  });

  it("drops a group the photograph has nothing to say about", () => {
    // A JPEG with no EXIF still has a name; an empty camera line would be a
    // blank stripe over the picture saying nothing.
    const lines = factLines(DEFAULT_OVERLAY_FACTS, { entry, meta: undefined, asShot: null });
    expect(lines.map((l) => l.group)).toEqual(["identity"]);
  });

  it("shows the facts it has when only some are tagged", () => {
    const partial = { ...shot, exif: { ...EXIF, lens: null, focalLength: null } };
    const lines = factLines(DEFAULT_OVERLAY_FACTS, { entry, meta: partial, asShot: null });
    expect(lines[1]?.parts).toEqual(["NIKON Z6_3"]);
    expect(lines[2]?.parts).toEqual(["1/200", "f/1.8", "ISO 4000"]);
  });

  it("says what the camera decided per shot, when the file recorded it", () => {
    // The answer to "why do these two neighbouring frames look different":
    // EV joins the exposure line, and the auto white balance solve plus the
    // Auto Picture Control grade get a line of their own. Zeroes stay
    // silent — an unmoved dial is not worth covering the photograph for.
    const graded = {
      ...shot,
      exif: { ...EXIF, exposureBias: -1 },
      grade: { contrast: -12, saturation: 10, clarity: 0, texture: 8 },
    };
    const lines = factLines(DEFAULT_OVERLAY_FACTS, {
      entry,
      meta: graded,
      asShot: { temperature: 4350, tint: 6 },
    });
    expect(lines.map((l) => l.group)).toEqual(["identity", "camera", "exposure", "grade"]);
    expect(lines[2]?.parts).toEqual(["50 mm", "1/200", "f/1.8", "ISO 4000", "−1 EV"]);
    expect(lines[3]?.parts).toEqual(["4350 K +6", "contrast −12 sat +10 texture +8"]);
  });

  it("ignores an id nobody registered, rather than throwing", () => {
    // A plugin that is no longer installed leaves its id behind in settings;
    // that must degrade to silence, as an unknown sort degrades to name order.
    expect(factLines(["nope", "name"], { entry, meta: shot, asShot: null })[0]?.parts).toEqual([
      "DSC_0178.NEF",
    ]);
  });
});
