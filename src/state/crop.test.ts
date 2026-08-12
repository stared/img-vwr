import { describe, expect, it } from "vitest";

import type { Crop } from "../ipc";
import {
  ASPECT_CHOICES,
  cornersOf,
  drawn,
  fitted,
  FULL_CROP,
  isCropped,
  MIN_EXTENT,
  moved,
  originalToRotated,
  ratioIn,
  ratioOf,
  resized,
  rotatedToOriginal,
  straightened,
  withRatio,
} from "./crop";

/** Index into a fixture, insisting it is there — a missing one is a broken
 * test, not a case to handle. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

/** A 3:2 frame, which is what almost every camera writes and the shape where
 * getting the isotropy wrong is most visible. */
const ASPECT = 3 / 2;

/** Every corner is inside the picture — the invariant the module exists for. */
function insideTheFrame(crop: Crop, aspect: number): boolean {
  const slack = 1e-4;
  return cornersOf(crop, aspect).every(
    (c) => c.x >= -slack && c.x <= 1 + slack && c.y >= -slack && c.y <= 1 + slack,
  );
}

describe("rotating between the frame and the turned frame", () => {
  it("comes back to where it started", () => {
    const crop: Crop = { x: 0.2, y: 0.15, width: 0.5, height: 0.4, angle: 12 };
    const point = { x: 0.42, y: 0.31 };
    const there = originalToRotated(crop, point.x, point.y, ASPECT);
    const back = rotatedToOriginal(crop, there.x, there.y, ASPECT);
    expect(back.x).toBeCloseTo(point.x, 6);
    expect(back.y).toBeCloseTo(point.y, 6);
  });

  it("keeps a rectangle a rectangle on a frame that is not square", () => {
    // The bug this catches: rotating in normalised coordinates, where a 3:2
    // frame stretches x by 1.5, shears the picture. Adjacent edges must stay
    // perpendicular — measured in the square space, which is where
    // "perpendicular" means anything.
    const crop: Crop = { x: 0.25, y: 0.25, width: 0.4, height: 0.4, angle: 27 };
    const corners = cornersOf(crop, ASPECT);
    const at = (i: number) => need(corners[i], `corner ${i}`);
    const edge = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
      x: (q.x - p.x) * ASPECT,
      y: q.y - p.y,
    });
    const e1 = edge(at(0), at(1));
    const e2 = edge(at(1), at(2));
    expect(e1.x * e2.x + e1.y * e2.y).toBeCloseTo(0, 6);
  });
});

describe("fitted", () => {
  it("leaves a crop that already fits exactly where it is", () => {
    const crop: Crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.3, angle: 0 };
    const out = fitted(crop, ASPECT);
    expect(out.x).toBeCloseTo(0.1, 6);
    expect(out.y).toBeCloseTo(0.2, 6);
    expect(out.width).toBeCloseTo(0.5, 6);
    expect(out.height).toBeCloseTo(0.3, 6);
  });

  it("slides a crop that has wandered off an edge back inside", () => {
    // Moved, not shrunk: it still fits, it is simply in the wrong place.
    const out = fitted({ x: 0.8, y: -0.3, width: 0.5, height: 0.4, angle: 0 }, ASPECT);
    expect(out.width).toBeCloseTo(0.5);
    expect(out.height).toBeCloseTo(0.4);
    expect(out.x).toBeCloseTo(0.5);
    expect(out.y).toBeCloseTo(0);
  });

  it("shrinks a turned crop until its corners are back in the picture", () => {
    // The whole frame turned by 10° reaches well outside itself at every
    // corner. Rendering that asks the pipeline for pixels the sensor never
    // recorded, and all it can do is smear the edge ones.
    const turned = straightened(FULL_CROP, 10, ASPECT);
    expect(insideTheFrame(turned, ASPECT)).toBe(true);
    expect(turned.width).toBeLessThan(1);
    expect(turned.height).toBeLessThan(1);
    // And it is the *largest* such crop, near enough: growing it by a percent
    // must put it back outside.
    const greedy = { ...turned, width: turned.width * 1.02, height: turned.height * 1.02 };
    expect(insideTheFrame(greedy, ASPECT)).toBe(false);
  });

  it("keeps the shape it was given while it shrinks", () => {
    const square = { x: 0.2, y: 0.1, width: 0.4, height: 0.6, angle: 0 };
    const before = ratioIn(square, ASPECT);
    const after = straightened(square, 20, ASPECT);
    expect(ratioIn(after, ASPECT)).toBeCloseTo(before, 5);
    expect(insideTheFrame(after, ASPECT)).toBe(true);
  });

  it("survives nonsense without producing any", () => {
    const wild = fitted(
      { x: Number.NaN, y: 9, width: 0, height: 40, angle: 900 },
      ASPECT,
    );
    expect(Number.isFinite(wild.x)).toBe(true);
    expect(wild.width).toBeGreaterThanOrEqual(MIN_EXTENT);
    expect(wild.angle).toBe(45);
    expect(insideTheFrame(wild, ASPECT)).toBe(true);
  });

  it("holds at every angle a straighten can reach", () => {
    for (let angle = -45; angle <= 45; angle += 3) {
      for (const aspect of [1, 3 / 2, 2 / 3, 16 / 9]) {
        const out = straightened({ x: 0.1, y: 0.1, width: 0.8, height: 0.7, angle: 0 }, angle, aspect);
        expect(insideTheFrame(out, aspect)).toBe(true);
      }
    }
  });
});

describe("moved", () => {
  it("takes the rectangle where the drag went", () => {
    const crop: Crop = { x: 0.1, y: 0.1, width: 0.4, height: 0.4, angle: 0 };
    const out = moved(crop, 0.2, 0.1, ASPECT);
    expect(out.x).toBeCloseTo(0.3);
    expect(out.y).toBeCloseTo(0.2);
    expect(out.width).toBeCloseTo(0.4);
  });

  it("stops at the edge rather than shrinking", () => {
    const crop: Crop = { x: 0.1, y: 0.1, width: 0.4, height: 0.4, angle: 0 };
    const out = moved(crop, 5, 5, ASPECT);
    expect(out.width).toBeCloseTo(0.4);
    expect(out.x + out.width).toBeCloseTo(1);
  });

  it("moves a turned crop along its own axes, not the sensor's", () => {
    // Dragging right on screen must move it right on screen. With a turned
    // frame that is not the frame's x — the whole reason the pointer is
    // converted into the turned space first.
    const crop: Crop = { x: 0.3, y: 0.3, width: 0.3, height: 0.3, angle: 30 };
    const out = moved(crop, 0.1, 0, ASPECT);
    expect(out.y).not.toBeCloseTo(crop.y, 3);
    expect(insideTheFrame(out, ASPECT)).toBe(true);
  });
});

describe("resized", () => {
  const crop: Crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6, angle: 0 };

  it("holds the opposite edge still", () => {
    // Pulling the east handle in must not move the west one: a rectangle you
    // adjust by re-centring is one you cannot adjust.
    const out = resized(crop, "e", { x: 0.1, y: 0 }, ASPECT, null);
    expect(out.x).toBeCloseTo(0.2);
    expect(out.width).toBeCloseTo(0.4);
    expect(out.height).toBeCloseTo(0.6);
  });

  it("never lets an edge cross the one opposite it", () => {
    const out = resized(crop, "e", { x: -5, y: 0 }, ASPECT, null);
    expect(out.width).toBeGreaterThanOrEqual(MIN_EXTENT);
    expect(out.x).toBeCloseTo(0.2);
  });

  it("derives the other dimension when a shape is locked", () => {
    const square = resized(crop, "se", { x: 0.2, y: 0.05 }, ASPECT, 1);
    expect(ratioIn(square, ASPECT)).toBeCloseTo(1, 3);
    // Anchored at the corner opposite the one dragged.
    expect(square.x).toBeCloseTo(0.2, 3);
    expect(square.y).toBeCloseTo(0.2, 3);
  });

  it("keeps the result inside the frame", () => {
    const out = resized(crop, "nw", { x: -3, y: -3 }, ASPECT, 16 / 9);
    expect(insideTheFrame(out, ASPECT)).toBe(true);
    expect(ratioIn(out, ASPECT)).toBeCloseTo(16 / 9, 2);
  });
});

describe("drawn", () => {
  it("builds the same rectangle whichever corner was dragged to", () => {
    const from = { x: -0.2, y: -0.15 };
    const to = { x: 0.2, y: 0.1 };
    const a = drawn(FULL_CROP, from, to, ASPECT);
    const b = drawn(FULL_CROP, to, from, ASPECT);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.width).toBeCloseTo(b.width, 6);
    expect(a.height).toBeCloseTo(b.height, 6);
  });

  it("carries the angle through, so straightening survives a re-drag", () => {
    const straight = straightened(FULL_CROP, -3.5, ASPECT);
    const out = drawn(straight, { x: -0.1, y: -0.1 }, { x: 0.1, y: 0.1 }, ASPECT);
    expect(out.angle).toBe(-3.5);
    expect(insideTheFrame(out, ASPECT)).toBe(true);
  });

  it("never produces a speck from a stray click", () => {
    const out = drawn(FULL_CROP, { x: 0, y: 0 }, { x: 0, y: 0 }, ASPECT);
    expect(out.width).toBeGreaterThanOrEqual(MIN_EXTENT);
    expect(out.height).toBeGreaterThanOrEqual(MIN_EXTENT);
  });
});

describe("shapes", () => {
  it("measures a ratio the way the exported file would", () => {
    // A crop half the width and the full height of a 3:2 frame is 3:4 —
    // measured in output pixels, not in the normalised numbers.
    const crop: Crop = { x: 0, y: 0, width: 0.5, height: 1, angle: 0 };
    expect(ratioIn(crop, ASPECT)).toBeCloseTo(0.75);
  });

  it("only ever takes when a shape is applied", () => {
    const crop: Crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8, angle: 0 };
    const square = withRatio(crop, 1, ASPECT);
    expect(ratioIn(square, ASPECT)).toBeCloseTo(1, 4);
    expect(square.width).toBeLessThanOrEqual(crop.width + 1e-6);
    expect(square.height).toBeLessThanOrEqual(crop.height + 1e-6);
  });

  it("turns a shape on its side without changing what it is", () => {
    const choice = need(ASPECT_CHOICES.find((c) => c.id === "3:2"), "3:2");
    expect(ratioOf(choice, ASPECT, false)).toBeCloseTo(1.5);
    expect(ratioOf(choice, ASPECT, true)).toBeCloseTo(1 / 1.5);
    // "as shot" is the frame's own shape, whatever that is.
    const original = need(ASPECT_CHOICES.find((c) => c.id === "original"), "as shot");
    expect(ratioOf(original, 16 / 9, false)).toBeCloseTo(16 / 9);
    expect(ratioOf(need(ASPECT_CHOICES[0], "free"), ASPECT, false)).toBeNull();
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
