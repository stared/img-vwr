import { describe, expect, it } from "vitest";

import { mosaicRows } from "./mosaic";

const GAP = 4;

/** A row's pixels, gaps included — what must meet the container's edge. */
function rowSpan(widths: number[]): number {
  return widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
}

describe("mosaic rows", () => {
  it("justifies every full row to the exact width", () => {
    const aspects = [1.5, 0.66, 1.5, 1.5, 0.66, 1.5, 1.0, 1.5];
    const rows = mosaicRows(aspects, 900, 180, GAP);
    for (const row of rows.slice(0, -1)) {
      expect(rowSpan(row.widths)).toBe(900);
      expect(row.height).toBeLessThanOrEqual(180);
    }
  });

  it("never stretches a sparse last row into billboards", () => {
    const rows = mosaicRows([1.5, 1.5], 2000, 180, GAP);
    expect(rows).toHaveLength(1);
    const only = rows[0];
    expect(only?.height).toBe(180);
    expect(rowSpan(only?.widths ?? [])).toBeLessThan(2000);
  });

  it("gives a lone panorama the whole width at whatever height that costs", () => {
    const rows = mosaicRows([4.0, 1.5, 1.5, 1.5], 800, 300, GAP);
    const first = rows[0];
    // The panorama fills its row alone: 800 / 4 = 200, under the target.
    expect(first?.count).toBe(1);
    expect(first?.widths[0]).toBe(800);
    expect(first?.height).toBe(200);
  });

  it("covers every entry exactly once, in order", () => {
    const aspects = Array.from({ length: 37 }, (_, i) => (i % 3 === 0 ? 0.66 : 1.5));
    const rows = mosaicRows(aspects, 1200, 160, GAP);
    let next = 0;
    for (const row of rows) {
      expect(row.firstIndex).toBe(next);
      expect(row.widths).toHaveLength(row.count);
      next += row.count;
    }
    expect(next).toBe(aspects.length);
  });

  it("shows nothing for an empty folder or an unmeasured pane", () => {
    expect(mosaicRows([], 900, 180, GAP)).toEqual([]);
    expect(mosaicRows([1.5], 0, 180, GAP)).toEqual([]);
  });
});
