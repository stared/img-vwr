import { describe, expect, it } from "vitest";

import { onStep, parseNumber, positionOf } from "./Slider";

describe("parseNumber", () => {
  it("reads back what the control wrote", () => {
    expect(parseNumber("2048 px")).toBe(2048);
    expect(parseNumber("+0.50 EV")).toBe(0.5);
    expect(parseNumber("-1.25")).toBe(-1.25);
    expect(parseNumber("6500 K")).toBe(6500);
    expect(parseNumber("90 · high")).toBe(90);
    expect(parseNumber("100%")).toBe(100);
    expect(parseNumber("+8.0°")).toBe(8);
  });

  it("takes a comma for a decimal point", () => {
    // The keyboard this is typed on has one where the point is.
    expect(parseNumber("1,5")).toBe(1.5);
  });

  it("says no rather than guessing", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("full size")).toBeNull();
    expect(parseNumber("  ")).toBeNull();
  });
});

describe("onStep", () => {
  it("lands on the control's own steps", () => {
    expect(onStep(2.7, 0, 10, 1)).toBe(3);
    expect(onStep(0.04, -5, 5, 0.01)).toBe(0.04);
    expect(onStep(87.4, 40, 100, 1)).toBe(87);
  });

  it("keeps a decimal step reading as a decimal", () => {
    // Guards: binary-float stepping made a tenth of a degree read as 8.100000000000001.
    expect(onStep(8.1, -45, 45, 0.1)).toBe(8.1);
    expect(onStep(0.30000000000000004, 0, 1, 0.05)).toBe(0.3);
    for (let i = -45; i <= 45; i += 1) {
      const value = onStep(i + 0.1, -45, 45, 0.1);
      expect(String(value).length).toBeLessThanOrEqual(5);
    }
  });

  it("never leaves the range, however it was asked to", () => {
    expect(onStep(999, 40, 100, 1)).toBe(100);
    expect(onStep(-999, 40, 100, 1)).toBe(40);
    expect(onStep(Number.NaN, 40, 100, 1)).toBe(40);
    expect(onStep(Number.POSITIVE_INFINITY, 0, 1, 0.01)).toBe(0);
  });

  it("leaves a stepless control alone", () => {
    expect(onStep(0.123456, 0, 1, 0)).toBeCloseTo(0.123456, 9);
  });
});

describe("positionOf", () => {
  it("places a value along the track", () => {
    expect(positionOf(50, 0, 100)).toBe(50);
    expect(positionOf(-5, -5, 5)).toBe(0);
    expect(positionOf(0, -5, 5)).toBe(50);
  });

  it("clamps rather than drawing a thumb off the end", () => {
    expect(positionOf(200, 0, 100)).toBe(100);
    expect(positionOf(-200, 0, 100)).toBe(0);
    // A degenerate range is a fact of life while a panel is still loading.
    expect(positionOf(5, 3, 3)).toBe(0);
  });
});
