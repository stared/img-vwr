import { describe, expect, it } from "vitest";

import { mosaicRows, packedOrder } from "./mosaic";

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

describe("packed order", () => {
  it("is a permutation — every photograph shown exactly once", () => {
    const aspects = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 0.66 : 1.5));
    const order = packedOrder(aspects, 5, 0.02);
    expect([...order].sort((a, b) => a - b)).toEqual(aspects.map((_, i) => i));
  });

  it("holds one scale where the sort's own order could not", () => {
    // The adversarial deal: a run of landscapes, then a run of portraits —
    // in order, rows are all-landscape then all-portrait, and their
    // justified heights land far apart.
    const aspects = [...Array<number>(8).fill(1.5), ...Array<number>(8).fill(2 / 3)];
    const width = 900;
    const target = 180;
    const heights = (rows: ReturnType<typeof mosaicRows>) =>
      rows.slice(0, -1).map((r) => r.height);

    const order = packedOrder(aspects, width / target, GAP / target);
    const packed = heights(mosaicRows(order.map((i) => aspects[i] ?? 1.5), width, target, GAP));
    for (const h of packed) {
      expect(Math.abs(h - target) / target).toBeLessThan(0.12);
    }

    const plain = heights(mosaicRows(aspects, width, target, GAP));
    const worst = Math.max(...plain.map((h) => Math.abs(h - target) / target));
    const packedWorst = Math.max(...packed.map((h) => Math.abs(h - target) / target));
    expect(packedWorst).toBeLessThanOrEqual(worst);
  });

  it("keeps chronology as the anchor: each row starts with the oldest waiting", () => {
    const aspects = [1.5, 0.66, 1.5, 0.66, 1.5, 0.66];
    const order = packedOrder(aspects, 4, 0.02);
    expect(order[0]).toBe(0);
  });
});
