import { describe, expect, it } from "vitest";

import {
  actualSize,
  clampPan,
  fitToWindow,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  zoomAtPoint,
} from "./viewport";

const IMG = { width: 2000, height: 1000 };
const WIN = { width: 800, height: 600 };

describe("fitToWindow", () => {
  it("downscales to fit and centers", () => {
    const v = fitToWindow(IMG, WIN);
    expect(v.scale).toBeCloseTo(0.4); // 800/2000
    expect(v.tx).toBeCloseTo(0);
    expect(v.ty).toBeCloseTo((600 - 1000 * 0.4) / 2);
  });

  it("never upscales a small image", () => {
    const v = fitToWindow({ width: 100, height: 50 }, WIN);
    expect(v.scale).toBe(1);
    expect(v.tx).toBeCloseTo(350);
    expect(v.ty).toBeCloseTo(275);
  });

  it("survives degenerate sizes", () => {
    expect(fitToWindow({ width: 0, height: 0 }, WIN).scale).toBe(1);
  });
});

describe("zoomAtPoint", () => {
  it("keeps the image point under the cursor fixed", () => {
    const v0 = fitToWindow(IMG, WIN);
    const cursor = { x: 300, y: 200 };
    const imagePointBefore = {
      x: (cursor.x - v0.tx) / v0.scale,
      y: (cursor.y - v0.ty) / v0.scale,
    };

    const v1 = zoomAtPoint(v0, cursor, 2);
    const imagePointAfter = {
      x: (cursor.x - v1.tx) / v1.scale,
      y: (cursor.y - v1.ty) / v1.scale,
    };

    expect(v1.scale).toBeCloseTo(v0.scale * 2);
    expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x);
    expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y);
  });

  it("clamps to scale bounds", () => {
    const v = { scale: 1, tx: 0, ty: 0 };
    expect(zoomAtPoint(v, { x: 0, y: 0 }, 1e9).scale).toBe(MAX_SCALE);
    expect(zoomAtPoint(v, { x: 0, y: 0 }, 1e-9).scale).toBe(MIN_SCALE);
  });
});

describe("clampPan", () => {
  it("centers axes smaller than the window", () => {
    const v = clampPan({ scale: 0.1, tx: -500, ty: -500 }, IMG, WIN);
    expect(v.tx).toBeCloseTo((800 - 200) / 2);
    expect(v.ty).toBeCloseTo((600 - 100) / 2);
  });

  it("clamps overflowing axes to the window edges", () => {
    // At scale 1 the image (2000x1000) overflows both axes of 800x600.
    const tooFarRight = clampPan({ scale: 1, tx: 100, ty: 100 }, IMG, WIN);
    expect(tooFarRight.tx).toBe(0);
    expect(tooFarRight.ty).toBe(0);

    const tooFarLeft = clampPan({ scale: 1, tx: -99999, ty: -99999 }, IMG, WIN);
    expect(tooFarLeft.tx).toBe(800 - 2000);
    expect(tooFarLeft.ty).toBe(600 - 1000);
  });

  it("pan then clamp stays within bounds", () => {
    const v = clampPan(panBy(actualSize(IMG, WIN), -5000, 5000), IMG, WIN);
    expect(v.tx).toBeGreaterThanOrEqual(800 - 2000);
    expect(v.tx).toBeLessThanOrEqual(0);
    expect(v.ty).toBe(0);
  });
});
