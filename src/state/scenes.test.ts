import { describe, expect, it } from "vitest";

import type { FileEntry, ImageMeta } from "../ipc";
import {
  groupScenes,
  sceneThreshold,
  sliderFromTau,
  tauFromSlider,
  sceneAt,
  sceneGapLabel,
  sceneJumpTarget,
  sceneLabel,
  sceneTimeOf,
} from "./scenes";

const MIN = 60_000;

function shot(name: string, modifiedMs: number): FileEntry {
  return { path: `/p/${name}`, name, size: 1, modifiedMs, formatHint: "jpg" };
}

function exifAt(ms: number): ImageMeta {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateTime = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return {
    width: 1,
    height: 1,
    format: "jpeg",
    fileSize: 1,
    modifiedMs: 0,
    grade: null,
    exif: {
      orientation: 1,
      dateTime,
      camera: null,
      lens: null,
      exposureTime: null,
      fNumber: null,
      iso: null,
      focalLength: null,
      exposureBias: null,
      gpsLat: null,
      gpsLon: null,
    },
  };
}

/** Noon on a fixed date, so labels are deterministic in local time. */
const NOON = new Date(2026, 7, 3, 12, 0, 0).getTime();

describe("groupScenes", () => {
  it("starts a new scene exactly when the gap is exceeded", () => {
    const entries = [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + 2 * MIN), // exactly the gap: same scene
      shot("c.jpg", NOON + 2 * MIN + 2 * MIN + 1), // just over: new scene
    ];
    const scenes = groupScenes(entries, {}, 2 * MIN, 1, null);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it("prefers when the photo was taken over when the file was written", () => {
    // Copying a card rewrites every file's clock; EXIF still knows the shoot.
    const entries = [shot("a.jpg", NOON + 500 * MIN), shot("b.jpg", NOON)];
    const meta = { "/p/a.jpg": exifAt(NOON), "/p/b.jpg": exifAt(NOON + MIN) };
    expect(groupScenes(entries, meta, 2 * MIN, 1, null)).toHaveLength(1);
    expect(sceneTimeOf(entries[0] as FileEntry, meta)).toBe(NOON);
  });

  it("measures gaps as distances, so a newest-first sort scenes the same", () => {
    const entries = [
      shot("c.jpg", NOON + 10 * MIN),
      shot("b.jpg", NOON + MIN),
      shot("a.jpg", NOON),
    ];
    const scenes = groupScenes(entries, {}, 2 * MIN, 1, null);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it("has no scenes for an empty list", () => {
    expect(groupScenes([], {}, 2 * MIN, 1, null)).toEqual([]);
  });
});

describe("content decides, time modulates", () => {
  // bands[i] = sims of entry i to i-1, i-2, i-3.
  it("splits a continuous run where the content changes, however short the pause", () => {
    const entries = [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + 5_000),
      shot("c.jpg", NOON + 10_000), // new scene, ten seconds later
      shot("d.jpg", NOON + 15_000),
    ];
    const bands = [[], [0.9], [0.4, 0.38], [0.88, 0.4, 0.39]];
    const scenes = groupScenes(entries, {}, 2 * MIN, 1, bands);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("bridges a long pause when the pictures barely moved", () => {
    const entries = [shot("a.jpg", NOON), shot("b.jpg", NOON + 20 * MIN)];
    expect(groupScenes(entries, {}, 2 * MIN, 1, [[], [0.95]])).toHaveLength(1);
  });

  it("needs more similarity the longer the pause", () => {
    const short = [shot("a.jpg", NOON), shot("b.jpg", NOON + 30_000)];
    expect(groupScenes(short, {}, 2 * MIN, 1, [[], [0.8]])).toHaveLength(1);
    const long = [shot("a.jpg", NOON), shot("b.jpg", NOON + 20 * MIN)];
    expect(groupScenes(long, {}, 2 * MIN, 1, [[], [0.8]])).toHaveLength(2);
  });

  it("holds alternating wide and close shots together via the band", () => {
    // The close-up matches neither neighbour but strongly matches the wide shot two back.
    const entries = [
      shot("wide1.jpg", NOON),
      shot("close.jpg", NOON + 5_000),
      shot("wide2.jpg", NOON + 10_000),
    ];
    const bands = [[], [0.5], [0.5, 0.9]];
    expect(groupScenes(entries, {}, 2 * MIN, 1, bands)).toHaveLength(1);
  });

  it("keeps one odd frame inside when the next rejoins the scene", () => {
    // b matches nothing, but c matches a over b's head, so b is not a boundary.
    const entries = [
      shot("a.jpg", NOON),
      shot("odd.jpg", NOON + 5_000),
      shot("c.jpg", NOON + 10_000),
    ];
    const bands = [[], [0.2], [0.25, 0.9]];
    expect(groupScenes(entries, {}, 2 * MIN, 1, bands)).toHaveLength(1);
  });

  it("still splits when the odd frame truly starts a new scene", () => {
    // b matches nothing behind it, and c matches only b: the scene changed at b.
    const entries = [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + 5_000),
      shot("c.jpg", NOON + 10_000),
    ];
    const bands = [[], [0.2], [0.9, 0.25]];
    const scenes = groupScenes(entries, {}, 2 * MIN, 1, bands);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it("falls back to the clock for unindexed photographs", () => {
    const entries = [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + MIN), // within tau: same scene
      shot("c.jpg", NOON + 10 * MIN), // beyond tau: new scene
    ];
    const bands = [[], [null], [null, null]];
    const scenes = groupScenes(entries, {}, 2 * MIN, 1, bands);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it("raises the bar smoothly between floor and ceiling", () => {
    expect(sceneThreshold(0, 2 * MIN, 1)).toBeCloseTo(0.55, 2);
    expect(sceneThreshold(2 * MIN, 2 * MIN, 1)).toBeCloseTo(0.79, 2);
    expect(sceneThreshold(60 * MIN, 2 * MIN, 1)).toBeCloseTo(0.93, 2);
  });
});

describe("sceneLabel", () => {
  it("names the first scene with its date, and later same-day scenes by clock", () => {
    const scenes = groupScenes(
      [shot("a.jpg", NOON), shot("b.jpg", NOON + 60 * MIN)],
      {},
      2 * MIN,
      1,
      null,
    );
    const [first, second] = scenes;
    if (!first || !second) throw new Error("expected two scenes");
    expect(sceneLabel(first, null, 12)).toBe("2026-08-03 12:00 · 12");
    expect(sceneLabel(second, first, 3)).toBe("13:00 · 3");
  });

  it("brings the date back when a scene starts on a new day", () => {
    const scenes = groupScenes(
      [shot("a.jpg", NOON), shot("b.jpg", NOON + 24 * 60 * MIN)],
      {},
      2 * MIN,
      1,
      null,
    );
    const [first, second] = scenes;
    if (!first || !second) throw new Error("expected two scenes");
    expect(sceneLabel(second, first, 1)).toBe("2026-08-04 12:00 · 1");
  });
});

describe("scene jumps", () => {
  const scenes = groupScenes(
    [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + MIN),
      shot("c.jpg", NOON + 30 * MIN),
      shot("d.jpg", NOON + 60 * MIN),
    ],
    {},
    2 * MIN,
    1,
    null,
  ); // scenes: [0,2), [2,3), [3,4)

  it("lands on the neighbouring scene's first photograph", () => {
    expect(sceneJumpTarget(scenes, 1, 1)).toBe(2);
    expect(sceneJumpTarget(scenes, 2, -1)).toBe(0);
  });

  it("enters from the end the arrow points from when nothing is selected", () => {
    expect(sceneJumpTarget(scenes, null, 1)).toBe(0);
    expect(sceneJumpTarget(scenes, null, -1)).toBe(3);
  });

  it("stops at the ends", () => {
    expect(sceneJumpTarget(scenes, 3, 1)).toBeNull();
    expect(sceneJumpTarget(scenes, 0, -1)).toBeNull();
    expect(sceneJumpTarget([], null, 1)).toBeNull();
  });

  it("knows which scene an index is in", () => {
    expect(sceneAt(scenes, 1)).toBe(0);
    expect(sceneAt(scenes, 3)).toBe(2);
    expect(sceneAt(scenes, 99)).toBeNull();
  });
});

describe("the content weight", () => {
  it("at zero reduces exactly to the hard clock, whatever the pictures say", () => {
    const entries = [
      shot("a.jpg", NOON),
      shot("b.jpg", NOON + MIN), // within tau, content totally different
      shot("c.jpg", NOON + 10 * MIN), // beyond tau, content near-identical
    ];
    const bands = [[], [0.1], [0.99, 0.1]];
    const scenes = groupScenes(entries, {}, 2 * MIN, 0, bands);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it("between the poles the requirement moves monotonically", () => {
    // Below tau the threshold rises with weight; above tau it falls from impossible toward the smooth curve.
    expect(sceneThreshold(30_000, 2 * MIN, 0.5)).toBeGreaterThan(0);
    expect(sceneThreshold(30_000, 2 * MIN, 0.5)).toBeLessThan(
      sceneThreshold(30_000, 2 * MIN, 1),
    );
    expect(sceneThreshold(10 * MIN, 2 * MIN, 0.5)).toBeGreaterThan(
      sceneThreshold(10 * MIN, 2 * MIN, 1),
    );
    expect(sceneThreshold(10 * MIN, 2 * MIN, 0)).toBeGreaterThan(1);
  });
});

describe("the scenes controls", () => {
  it("the time slider is logarithmic and round-trips", () => {
    expect(tauFromSlider(0)).toBeCloseTo(0.5, 5);
    expect(tauFromSlider(1)).toBeCloseTo(60, 5);
    // Log scale: the midpoint is the geometric mean, not the average.
    expect(tauFromSlider(0.5)).toBeCloseTo(Math.sqrt(0.5 * 60), 3);
    for (const tau of [0.5, 2, 7.3, 60]) {
      expect(tauFromSlider(sliderFromTau(tau))).toBeCloseTo(tau, 5);
    }
  });

  it("names the value in the unit a human would pick", () => {
    expect(sceneGapLabel(0.5)).toBe("~30 s");
    expect(sceneGapLabel(2)).toBe("~2 min");
    expect(sceneGapLabel(2.24)).toBe("~2 min");
    expect(sceneGapLabel(15.2)).toBe("~15 min");
    expect(sceneGapLabel(60)).toBe("~1 h");
  });
});
