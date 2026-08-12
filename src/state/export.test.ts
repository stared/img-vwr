import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import {
  candidatesOf,
  DEFAULT_OPTIONS,
  planAll,
  planFor,
  qualityLabel,
  QUALITY_MARKS,
  QUALITY_MAX,
  QUALITY_MIN,
  nativeSizeOf,
  sameSize,
  sizeFromSlider,
  sizeLabel,
  sizeMarksFor,
  sizeScaleFor,
  sliderFromSize,
  summaryOf,
  UNKNOWN_SIZE,
  type Candidate,
} from "./export";

function file(path: string): FileEntry {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    formatHint: dot < 0 ? "" : name.slice(dot + 1).toLowerCase(),
    size: 1,
    modifiedMs: 0,
  };
}

/** Index into a fixture, insisting it is there — a missing one is a broken
 * test, not a case to handle. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

/** A shoot the way a camera writes one: a raw and a JPEG per frame. */
const PAIRS = ["/shoot/DSC_0001", "/shoot/DSC_0002", "/shoot/DSC_0003"];
const SCAN = PAIRS.flatMap((stem) => [file(`${stem}.NEF`), file(`${stem}.JPG`)]);

function candidate(stem: string, edited: boolean): Candidate {
  const stack = SCAN.filter((f) => f.path.startsWith(stem));
  return { entry: need(stack.find((f) => f.formatHint === "nef"), "a raw"), stack, edited };
}

describe("planFor", () => {
  it("copies the camera's JPG for a raw nobody edited", () => {
    const planned = planFor(candidate("/shoot/DSC_0001", false), DEFAULT_OPTIONS);
    expect(planned.reason).toBe("camera-jpg");
    expect(planned.job).toEqual({ kind: "copy", path: "/shoot/DSC_0001.JPG" });
  });

  it("develops a raw that has an edit, whatever the policy says", () => {
    const planned = planFor(candidate("/shoot/DSC_0001", true), DEFAULT_OPTIONS);
    expect(planned.reason).toBe("edited");
    expect(planned.job.kind).toBe("render");
  });

  it("develops an untouched raw with no JPG beside it", () => {
    const lone = file("/shoot/DSC_0009.NEF");
    const planned = planFor({ entry: lone, stack: [lone], edited: false }, DEFAULT_OPTIONS);
    expect(planned.reason).toBe("no-jpg");
    expect(planned.job).toEqual({
      kind: "render",
      path: "/shoot/DSC_0009.NEF",
      exif: { kind: "none" },
    });
  });

  it("gives a developed frame the metadata of the JPG shot beside it", () => {
    // Rendered pixels have no EXIF of their own; the frame next to them on
    // the card knows the date, the lens and the exposure.
    const planned = planFor(candidate("/shoot/DSC_0002", true), DEFAULT_OPTIONS);
    expect(planned.job).toEqual({
      kind: "render",
      path: "/shoot/DSC_0002.NEF",
      exif: { kind: "file", path: "/shoot/DSC_0002.JPG" },
    });
  });

  it("develops everything when asked to", () => {
    const planned = planFor(candidate("/shoot/DSC_0003", false), {
      ...DEFAULT_OPTIONS,
      unedited: "render",
    });
    expect(planned.reason).toBe("always-render");
    expect(planned.job.kind).toBe("render");
  });

  it("develops everything for a PNG export, because a JPG is not a PNG", () => {
    const planned = planFor(candidate("/shoot/DSC_0003", false), {
      ...DEFAULT_OPTIONS,
      format: { kind: "png" },
    });
    expect(planned.job.kind).toBe("render");
  });

  it("copies an untouched JPEG rather than encoding it again", () => {
    // Re-encoding pixels nobody changed can only lose, and takes longer.
    const jpg = need(SCAN.find((f) => f.path === "/shoot/DSC_0001.JPG"), "the JPG");
    const planned = planFor(
      { entry: jpg, stack: [jpg], edited: false },
      DEFAULT_OPTIONS,
    );
    expect(planned.job).toEqual({ kind: "copy", path: "/shoot/DSC_0001.JPG" });
  });
});

describe("candidatesOf", () => {
  it("finds the whole stack behind each chosen photograph", () => {
    const chosen = [need(SCAN[0], "the first file")];
    const [candidate] = candidatesOf(chosen, SCAN, new Set());
    expect(candidate?.stack.map((f) => f.name).sort()).toEqual([
      "DSC_0001.JPG",
      "DSC_0001.NEF",
    ]);
  });

  it("counts a photograph as edited when any of its files is", () => {
    // The edit was made on whichever half of the pair was on screen; the
    // frame is one photograph either way.
    const chosen = [need(SCAN[1], "the JPG")];
    const [candidate] = candidatesOf(chosen, SCAN, new Set(["/shoot/DSC_0001.NEF"]));
    expect(candidate?.edited).toBe(true);
  });
});

describe("summaryOf", () => {
  it("says how the export splits before anything is written", () => {
    const planned = planAll(
      [
        candidate("/shoot/DSC_0001", true),
        candidate("/shoot/DSC_0002", false),
        candidate("/shoot/DSC_0003", false),
      ],
      DEFAULT_OPTIONS,
    );
    expect(summaryOf(planned)).toBe(
      "3 photographs: 1 developed, 2 copied from the camera's JPG",
    );
  });

  it("does not split a total that has only one side", () => {
    const all = planAll([candidate("/shoot/DSC_0001", true)], DEFAULT_OPTIONS);
    expect(summaryOf(all)).toBe("1 photograph, all developed");
    const none = planAll([candidate("/shoot/DSC_0001", false)], DEFAULT_OPTIONS);
    expect(summaryOf(none)).toBe("1 photograph, all copied from the camera's JPG");
    expect(summaryOf([])).toBe("nothing selected");
  });
});

describe("sameSize", () => {
  it("tells the sizes apart so a mark can say which one is on", () => {
    expect(sameSize({ kind: "full" }, { kind: "full" })).toBe(true);
    expect(sameSize({ kind: "full" }, { kind: "longest", pixels: 2048 })).toBe(false);
    expect(
      sameSize({ kind: "longest", pixels: 2048 }, { kind: "longest", pixels: 2048 }),
    ).toBe(true);
    expect(
      sameSize({ kind: "longest", pixels: 2048 }, { kind: "longest", pixels: 1024 }),
    ).toBe(false);
  });
});

describe("the size scale", () => {
  /** A 24 MP frame from a 3:2 body — 6048 px on its long edge. */
  const shoot = sizeScaleFor(6048);
  const mine = { longest: 6048, mixed: false };

  it("puts a size back where it came from", () => {
    // The thumb has to sit on the value the readout claims, or the control is
    // lying about what it will export.
    for (const pixels of [512, 1024, 1600, 2048, 4096, 6048]) {
      const size = { kind: "longest", pixels } as const;
      expect(sizeFromSlider(sliderFromSize(size, shoot), shoot)).toEqual(size);
    }
    expect(sizeFromSlider(sliderFromSize({ kind: "full" }, shoot), shoot)).toEqual({
      kind: "full",
    });
  });

  it("spends its track on sizes people pick", () => {
    // Logarithmic: doubling the size is the same distance wherever you are,
    // so half the track is not wasted on the very large end.
    const a = sliderFromSize({ kind: "longest", pixels: 1024 }, shoot);
    const b = sliderFromSize({ kind: "longest", pixels: 2048 }, shoot);
    const c = sliderFromSize({ kind: "longest", pixels: 4096 }, shoot);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it("ends at the largest photograph rather than at some fixed ceiling", () => {
    // An export never upscales, so a track that ran past the real maximum
    // would have a stretch where every position meant the same thing.
    expect(shoot.max).toBe(6048);
    expect(sizeFromSlider(0.97, shoot)).toEqual({ kind: "longest", pixels: 6048 });
    expect(sizeFromSlider(1, shoot)).toEqual({ kind: "full" });
    // ...and a small collection gets a small track.
    const small = sizeScaleFor(1600);
    expect(sizeFromSlider(0.97, small)).toEqual({ kind: "longest", pixels: 1600 });
  });

  it("falls back to a sensible range before any file has been measured", () => {
    const unknown = sizeScaleFor(null);
    expect(unknown.max).toBe(8192);
    expect(sizeFromSlider(0, unknown)).toEqual({ kind: "longest", pixels: 512 });
  });

  it("reads out a number a person would say", () => {
    // Rounded to 16 px, so a hair of thumb movement is not a different export.
    for (const at of [0.13, 0.37, 0.62, 0.88]) {
      const size = sizeFromSlider(at, shoot);
      expect(size.kind === "longest" && size.pixels % 16).toBe(0);
    }
    expect(sizeLabel({ kind: "longest", pixels: 2048 }, mine)).toBe("2048 px");
  });

  it("says which size 'full size' means", () => {
    // "full size" alone is a question, not an answer.
    expect(sizeLabel({ kind: "full" }, mine)).toBe("full size · 6048 px");
    expect(sizeLabel({ kind: "full" }, { longest: 6048, mixed: true })).toBe(
      "full size · up to 6048 px",
    );
    // ...and says nothing it does not know.
    expect(sizeLabel({ kind: "full" }, UNKNOWN_SIZE)).toBe("full size");
  });

  it("survives a slider that has gone wrong", () => {
    expect(sizeFromSlider(Number.NaN, shoot)).toEqual({ kind: "full" });
    expect(sizeFromSlider(-1, shoot)).toEqual({ kind: "longest", pixels: 512 });
  });

  it("marks the sizes worth landing on, and only ones it could produce", () => {
    expect(sizeMarksFor(shoot).map((m) => sizeLabel(m.size, mine))).toEqual([
      "1024 px",
      "2048 px",
      "4096 px",
      "full size · 6048 px",
    ]);
    // A collection of small photographs has no business offering 4096.
    expect(sizeMarksFor(sizeScaleFor(1600)).map((m) => m.size.kind)).toEqual([
      "longest",
      "full",
    ]);
    for (const mark of sizeMarksFor(shoot)) {
      const at = sliderFromSize(mark.size, shoot);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(1);
    }
  });
});

describe("nativeSizeOf", () => {
  const dims: Record<string, { width: number; height: number }> = {
    "/shoot/DSC_0001.NEF": { width: 6048, height: 4024 },
    "/shoot/DSC_0001.JPG": { width: 6048, height: 4024 },
    "/shoot/DSC_0002.JPG": { width: 3000, height: 2000 },
  };
  const lookup = (path: string) => dims[path] ?? null;

  it("takes the longest edge in the selection", () => {
    const files = Object.keys(dims).map((path) => ({ path }));
    expect(nativeSizeOf(files, lookup)).toEqual({ longest: 6048, mixed: true });
  });

  it("says so when they all agree", () => {
    const pair = [{ path: "/shoot/DSC_0001.NEF" }, { path: "/shoot/DSC_0001.JPG" }];
    expect(nativeSizeOf(pair, lookup)).toEqual({ longest: 6048, mixed: false });
  });

  it("does not wait for metadata that has not arrived", () => {
    // The number labels a control. Waiting for the slowest file in a folder of
    // two thousand would mean it never appeared at all.
    expect(nativeSizeOf([{ path: "/nothing/known.JPG" }], lookup)).toEqual(UNKNOWN_SIZE);
    const partial = [{ path: "/nothing/known.JPG" }, { path: "/shoot/DSC_0002.JPG" }];
    expect(nativeSizeOf(partial, lookup)).toEqual({ longest: 3000, mixed: false });
  });
});

describe("qualityLabel", () => {
  it("says which neighbourhood a number is in", () => {
    // "90" means nothing to somebody who has not encoded a JPEG by hand.
    expect(qualityLabel(100)).toBe("100 · maximum");
    expect(qualityLabel(90)).toBe("90 · high");
    expect(qualityLabel(80)).toBe("80 · web");
    expect(qualityLabel(50)).toBe("50 · small");
  });

  it("marks the qualities people use", () => {
    expect(QUALITY_MARKS.map((m) => m.at)).toEqual([80, 90, 100]);
    for (const mark of QUALITY_MARKS) {
      expect(mark.at).toBeGreaterThanOrEqual(QUALITY_MIN);
      expect(mark.at).toBeLessThanOrEqual(QUALITY_MAX);
    }
  });
});

// Kept honest: the summary is derived from the jobs, never from the options,
// so it cannot claim a split the export will not carry out.
describe("the summary and the jobs agree", () => {
  it("counts exactly the copies that will happen", () => {
    const planned = planAll(
      PAIRS.map((stem, at) => candidate(stem, at === 0)),
      DEFAULT_OPTIONS,
    );
    const copies = planned.filter((p) => p.job.kind === "copy").length;
    expect(summaryOf(planned)).toContain(`${copies} copied`);
  });
});
