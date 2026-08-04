import { describe, expect, it } from "vitest";

import { stripRange } from "./Filmstrip";

/* The strip's cells are `height - 12` wide with a 6 px gap and 8 px of
 * container padding, so at height 160 the pitch is 154 and the first cell
 * starts at 8. Those are the numbers the CSS actually produces. */
const layout = { origin: 8, pitch: 154 };

describe("stripRange", () => {
  it("covers what is on screen, deep into a long strip", () => {
    // Frame 117 of 170: the case that was broken. A pitch guessed as
    // `height + 6` (166) instead of the real 154 put the requested window
    // nine cells past the visible one, and the strip sat blank.
    const scrollLeft = 117 * 154;
    const { first, last } = stripRange({ scrollLeft, clientWidth: 1540 }, layout, 170);
    expect(first).toBeLessThanOrEqual(117);
    expect(last).toBeGreaterThanOrEqual(127);
    // And not the whole collection — this is a fetch list.
    expect(last - first).toBeLessThan(30);
  });

  it("starts at the beginning when the strip has not been scrolled", () => {
    expect(stripRange({ scrollLeft: 0, clientWidth: 1540 }, layout, 170).first).toBe(0);
  });

  it("never runs past either end", () => {
    expect(stripRange({ scrollLeft: -20, clientWidth: 100 }, layout, 10).first).toBe(0);
    const far = stripRange({ scrollLeft: 99_000, clientWidth: 1540 }, layout, 10);
    expect(far.last).toBe(10);
  });

  it("asks for nothing when there is nothing laid out to measure", () => {
    expect(stripRange({ scrollLeft: 0, clientWidth: 800 }, { origin: 0, pitch: 0 }, 5)).toEqual({
      first: 0,
      last: 0,
    });
    expect(stripRange({ scrollLeft: 0, clientWidth: 800 }, layout, 0)).toEqual({
      first: 0,
      last: 0,
    });
  });
});
