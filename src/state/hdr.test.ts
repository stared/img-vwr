import { describe, expect, it } from "vitest";

import type { FileEntry, ImageMeta } from "../ipc";
import {
  exposureValue,
  fusionMap,
  hdrLabel,
  hdrSetsOf,
  MIN_SPREAD,
  takenMs,
} from "./hdr";
import { collapseStacks, siblingsOf } from "./stacks";

function entry(name: string): FileEntry {
  return { path: `/shoot/${name}`, name, size: 1, modifiedMs: 0, formatHint: name.split(".").pop() ?? "" };
}

interface Exposure {
  at: string;
  t: number;
  iso?: number;
  focal?: number;
}

function metaOf(exposures: Record<string, Exposure>): (path: string) => ImageMeta | null {
  return (path) => {
    const name = path.split("/").pop() ?? "";
    const exposure = exposures[name];
    if (!exposure) return null;
    return {
      width: 6048,
      height: 4024,
      format: "jpg",
      fileSize: 1,
      modifiedMs: 0,
      grade: null,
      exif: {
        orientation: 1,
        dateTime: exposure.at,
        camera: null,
        lens: null,
        exposureTime: exposure.t,
        fNumber: 1.8,
        iso: exposure.iso ?? 100,
        exposureBias: null,
        focalLength: exposure.focal ?? 120,
        gpsLat: null,
        gpsLon: null,
      },
    };
  };
}

/** The shape of the real eclipse brackets: five frames inside two seconds,
 * shutter and ISO sweeping stops apart. */
const ECLIPSE: Record<string, Exposure> = {
  "DSC_1115.JPG": { at: "2026-08-12 17:36:34", t: 1 / 160 },
  "DSC_1116.JPG": { at: "2026-08-12 17:36:34", t: 1 / 2000 },
  "DSC_1117.JPG": { at: "2026-08-12 17:36:34", t: 1 / 800 },
  "DSC_1118.JPG": { at: "2026-08-12 17:36:35", t: 1 / 125, iso: 1400 },
  "DSC_1119.JPG": { at: "2026-08-12 17:36:35", t: 1 / 125, iso: 5600 },
};

describe("hdrSetsOf", () => {
  it("finds a burst whose exposure sweeps, fronted by its middle exposure", () => {
    const files = Object.keys(ECLIPSE).map(entry);
    const sets = hdrSetsOf(files, metaOf(ECLIPSE));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.frames.map((f) => f.name)).toEqual(Object.keys(ECLIPSE));
    expect(sets[0]?.spread).toBeGreaterThan(5);
    // EVs sort 1116 < 1117 < 1115 < 1118 < 1119; the middle is 1115.
    expect(sets[0]?.face.name).toBe("DSC_1115.JPG");
  });

  it("does not mistake auto-ISO drift for a bracket", () => {
    // Continuous shooting: same shutter, ISO wandering by a third of a stop.
    const drift: Record<string, Exposure> = {
      "DSC_0001.JPG": { at: "2026-08-12 11:53:56", t: 1 / 8000, iso: 200 },
      "DSC_0002.JPG": { at: "2026-08-12 11:53:57", t: 1 / 8000, iso: 160 },
      "DSC_0003.JPG": { at: "2026-08-12 11:53:58", t: 1 / 8000, iso: 180 },
    };
    expect(hdrSetsOf(Object.keys(drift).map(entry), metaOf(drift))).toHaveLength(0);
  });

  it("treats frames more than two seconds apart as separate moments", () => {
    // The same sweep, but shot slowly: somebody adjusting, not bracketing.
    const slow: Record<string, Exposure> = {
      "DSC_0001.JPG": { at: "2026-08-12 17:33:15", t: 1 / 5000 },
      "DSC_0002.JPG": { at: "2026-08-12 17:33:34", t: 1 / 640 },
      "DSC_0003.JPG": { at: "2026-08-12 17:33:48", t: 1 / 80 },
    };
    expect(hdrSetsOf(Object.keys(slow).map(entry), metaOf(slow))).toHaveLength(0);
  });

  it("counts each photograph once when the raw sits beside the JPEG", () => {
    const files = Object.keys(ECLIPSE).flatMap((name) => [
      entry(name),
      entry(name.replace(".JPG", ".NEF")),
    ]);
    const sets = hdrSetsOf(files, metaOf(ECLIPSE));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.frames).toHaveLength(5);
    expect(sets[0]?.frames.every((f) => f.name.endsWith(".JPG"))).toBe(true);
  });

  it("never mistakes an exported merge for a frame of the bracket", () => {
    // An exported merge carries a source frame's EXIF verbatim — same
    // moment, same exposure. Counted as a frame, it would join the very
    // burst it was made from.
    const withMerged: Record<string, Exposure> = {
      ...ECLIPSE,
      "DSC_1115-HDR.jpg": ECLIPSE["DSC_1115.JPG"] as Exposure,
    };
    const files = Object.keys(withMerged).map(entry);
    const sets = hdrSetsOf(files, metaOf(withMerged));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.frames).toHaveLength(5);
  });

  it("answers from the metadata that has arrived and grows as it lands", () => {
    const files = Object.keys(ECLIPSE).map(entry);
    expect(hdrSetsOf(files, () => null)).toHaveLength(0);
    expect(hdrSetsOf(files, metaOf(ECLIPSE))).toHaveLength(1);
  });

  it("refuses a burst that zoomed mid-way", () => {
    const zoomed: Record<string, Exposure> = {
      "DSC_0001.JPG": { at: "2026-08-12 17:36:34", t: 1 / 2000, focal: 50 },
      "DSC_0002.JPG": { at: "2026-08-12 17:36:34", t: 1 / 250, focal: 50 },
      "DSC_0003.JPG": { at: "2026-08-12 17:36:35", t: 1 / 30, focal: 120 },
    };
    expect(hdrSetsOf(Object.keys(zoomed).map(entry), metaOf(zoomed))).toHaveLength(0);
  });

  it("splits around a long pause and judges each burst alone", () => {
    const two: Record<string, Exposure> = {
      ...ECLIPSE,
      "DSC_1130.JPG": { at: "2026-08-12 17:58:31", t: 1 / 400 },
      "DSC_1131.JPG": { at: "2026-08-12 17:58:31", t: 1 / 6400 },
      "DSC_1132.JPG": { at: "2026-08-12 17:58:32", t: 1 / 1600 },
    };
    const sets = hdrSetsOf(Object.keys(two).map(entry), metaOf(two));
    expect(sets).toHaveLength(2);
    expect(sets[1]?.frames).toHaveLength(3);
    // EVs sort 1130 < 1132 < 1131: the middle exposure is 1132.
    expect(sets[1]?.face.name).toBe("DSC_1132.JPG");
  });
});

describe("an HDR set is one photograph to the rest of the app", () => {
  /** The whole set's files as the grid would list them, raws included. */
  const files = Object.keys(ECLIPSE).flatMap((name) => [
    entry(name),
    entry(name.replace(".JPG", ".NEF")),
  ]);
  const sets = hdrSetsOf(files, metaOf(ECLIPSE));
  const keyByStack = new Map(
    sets.flatMap((s) => s.frames.map((f) => [`/shoot/${f.name.replace(/\..*$/, "")}`, s.face.path])),
  );

  it("collapses the whole bracket to its face where stacks collapse", () => {
    const shown = collapseStacks(files, {}, "jpg", keyByStack);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.name).toBe("DSC_1115.JPG");
    // Without the HDR keys the same list is five ordinary raw+JPEG stacks.
    expect(collapseStacks(files, {}, "jpg", null)).toHaveLength(5);
  });

  it("still lets a picked member stand in front", () => {
    const face = sets[0]?.face.path ?? "";
    const shown = collapseStacks(files, { [face]: "/shoot/DSC_1119.JPG" }, "jpg", keyByStack);
    expect(shown[0]?.name).toBe("DSC_1119.JPG");
  });

  it("counts every other file of the set as a sibling of the face", () => {
    const face = files.find((f) => f.name === "DSC_1115.JPG");
    expect(face).toBeDefined();
    if (!face) return;
    expect(siblingsOf(files, face, keyByStack)).toHaveLength(9);
    expect(siblingsOf(files, face)).toHaveLength(1);
  });

  it("hands the develop service every frame behind the face path", () => {
    const map = fusionMap(sets);
    expect(map["/shoot/DSC_1115.JPG"]).toHaveLength(5);
    expect(map["/shoot/DSC_1115.JPG"]?.[0]).toBe("/shoot/DSC_1115.JPG");
  });

  it("names itself by what it is", () => {
    const set = sets[0];
    expect(set).toBeDefined();
    if (!set) return;
    expect(hdrLabel(set)).toBe("HDR ×5 · 9.8 EV");
  });
});

describe("exposureValue", () => {
  it("measures the sweep of a real bracket in stops", () => {
    // 1/8000 against 1/125 at the same aperture is six stops; ISO 100
    // against 500 is another two and a third.
    const short = exposureValue({ exposureTime: 1 / 8000, fNumber: 1.8, iso: 100 });
    const long = exposureValue({ exposureTime: 1 / 125, fNumber: 1.8, iso: 500 });
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect((short ?? 0) - (long ?? 0)).toBeCloseTo(6 + Math.log2(5), 1);
  });

  it("has no answer without a shutter speed", () => {
    expect(exposureValue({ exposureTime: null, fNumber: 1.8, iso: 100 })).toBeNull();
    expect(exposureValue({ exposureTime: 0, fNumber: 1.8, iso: 100 })).toBeNull();
  });

  it("keeps auto-ISO jitter under the sweep threshold", () => {
    const a = exposureValue({ exposureTime: 1 / 8000, fNumber: 1.8, iso: 160 });
    const b = exposureValue({ exposureTime: 1 / 8000, fNumber: 1.8, iso: 200 });
    expect(Math.abs((a ?? 0) - (b ?? 0))).toBeLessThan(MIN_SPREAD);
  });
});

describe("takenMs", () => {
  it("reads both the EXIF separator and the displayed one", () => {
    const colons = takenMs("2026:08:12 17:36:34");
    const dashes = takenMs("2026-08-12 17:36:34");
    expect(colons).not.toBeNull();
    expect(colons).toBe(dashes);
  });

  it("subtracts to the gap between frames", () => {
    const a = takenMs("2026-08-12 17:36:34");
    const b = takenMs("2026-08-12 17:36:36");
    expect((b ?? 0) - (a ?? 0)).toBe(2000);
  });

  it("has no answer for what it cannot read", () => {
    expect(takenMs(null)).toBeNull();
    expect(takenMs("last tuesday")).toBeNull();
  });
});
