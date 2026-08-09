import { describe, expect, it } from "vitest";

import type { FileEntry, ImageMeta } from "../ipc";
import {
  groupScenes,
  nextSceneGap,
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
    exif: {
      orientation: 1,
      dateTime,
      camera: null,
      lens: null,
      exposureTime: null,
      fNumber: null,
      iso: null,
      focalLength: null,
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
    const scenes = groupScenes(entries, {}, 2 * MIN, null);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it("prefers when the photo was taken over when the file was written", () => {
    // Copying a card rewrites every file's clock; EXIF still knows the shoot.
    const entries = [shot("a.jpg", NOON + 500 * MIN), shot("b.jpg", NOON)];
    const meta = { "/p/a.jpg": exifAt(NOON), "/p/b.jpg": exifAt(NOON + MIN) };
    expect(groupScenes(entries, meta, 2 * MIN, null)).toHaveLength(1);
    expect(sceneTimeOf(entries[0] as FileEntry, meta)).toBe(NOON);
  });

  it("measures gaps as distances, so a newest-first sort scenes the same", () => {
    const entries = [
      shot("c.jpg", NOON + 10 * MIN),
      shot("b.jpg", NOON + MIN),
      shot("a.jpg", NOON),
    ];
    const scenes = groupScenes(entries, {}, 2 * MIN, null);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it("has no scenes for an empty list", () => {
    expect(groupScenes([], {}, 2 * MIN, null)).toEqual([]);
  });
});

describe("embedding refinement", () => {
  const entries = [
    shot("a.jpg", NOON),
    shot("b.jpg", NOON + 10 * MIN), // long pause
    shot("c.jpg", NOON + 10 * MIN + 30_000), // half a minute later
  ];

  it("bridges a long pause when the content stayed the same", () => {
    // The photographer waited; the scene did not end. sims[0] describes
    // the (a, b) pair.
    const scenes = groupScenes(entries, {}, 2 * MIN, [0.95, 0.7]);
    expect(scenes).toHaveLength(1);
  });

  it("splits a close pair when the content moved on", () => {
    // Ten seconds apart but pointing at a different thing entirely — only
    // when the pause is a fair share of the gap, so a burst's odd frame
    // never cuts a scene (here 30 s against a 2 min gap qualifies).
    const scenes = groupScenes(entries, {}, 2 * MIN, [0.2, 0.3]);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("never splits within a burst, however odd one frame looks", () => {
    const burst = [shot("a.jpg", NOON), shot("b.jpg", NOON + 1000)];
    expect(groupScenes(burst, {}, 2 * MIN, [0.1])).toHaveLength(1);
  });

  it("leaves the clock's verdict alone for unindexed pairs", () => {
    const scenes = groupScenes(entries, {}, 2 * MIN, [null, null]);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });
});

describe("sceneLabel", () => {
  it("names the first scene with its date, and later same-day scenes by clock", () => {
    const scenes = groupScenes(
      [shot("a.jpg", NOON), shot("b.jpg", NOON + 60 * MIN)],
      {},
      2 * MIN,
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

describe("the scenes control", () => {
  it("cycles off through the offered gaps and back to off", () => {
    expect(nextSceneGap(null)).toBe(2);
    expect(nextSceneGap(2)).toBe(5);
    expect(nextSceneGap(5)).toBe(15);
    expect(nextSceneGap(15)).toBeNull();
  });

  it("states its value in words", () => {
    expect(sceneGapLabel(null)).toBe("scenes: off");
    expect(sceneGapLabel(2)).toBe("scenes: 2 min gaps");
  });
});
