import { describe, expect, it } from "vitest";

import { bandedMosaic, mosaicRows, rowsToBands, verticalNeighbor } from "./mosaic";

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

describe("banded one-scale packing", () => {
  const L = 180;
  const W = 1200;

  it("shows every photograph exactly once", () => {
    const aspects = Array.from({ length: 41 }, (_, i) => (i % 3 === 0 ? 2 / 3 : 1.5));
    const bands = bandedMosaic(aspects, W, L);
    const shown = bands
      .flatMap((b) => b.cells.map((c) => c.index))
      .sort((a, b) => a - b);
    expect(shown).toEqual(aspects.map((_, i) => i));
  });

  it("tiles every band with no holes: cells cover it edge to edge", () => {
    const aspects = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 2 / 3 : 1.5));
    const bands = bandedMosaic(aspects, W, L);
    for (const band of bands.slice(0, -1)) {
      const area = band.cells.reduce((sum, c) => sum + c.width * c.height, 0);
      expect(area).toBe(W * band.height);
      for (const cell of band.cells) {
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.x + cell.width).toBeLessThanOrEqual(W);
        expect(cell.y + cell.height).toBeLessThanOrEqual(band.height);
      }
    }
  });

  it("shows a rotated sensor at one scale: equal diagonals for both orientations", () => {
    // In a height-only row a portrait renders at 2/3 the landscape's scale; here diagonals must come out equal.
    const aspects = Array.from({ length: 48 }, (_, i) => (i % 5 < 2 ? 2 / 3 : 1.5));
    const bands = bandedMosaic(aspects, W, L);
    expect(bands.length).toBeGreaterThan(1);
    for (const band of bands.slice(0, -1)) {
      const diagonals = band.cells.map((c) => Math.hypot(c.width, c.height));
      const [min, max] = [Math.min(...diagonals), Math.max(...diagonals)];
      expect(max - min).toBeLessThan(max * 0.02);
      // This narrow pane (6.7 landscape-widths) is near the worst case for the justify correction, hence the loose 0.3.
      expect(Math.abs(max - Math.hypot(1.5, 1) * L) / max).toBeLessThan(0.3);
    }
  });

  it("stands portraits taller than landscapes, not smaller beside them", () => {
    const aspects = [1.5, 1.5, 1.5, 2 / 3, 2 / 3, 1.5, 1.5, 1.5, 2 / 3, 2 / 3];
    const bands = bandedMosaic(aspects, W, L);
    const cells = bands.flatMap((b) => b.cells);
    const portrait = cells.find((c) => (aspects[c.index] ?? 0) < 1);
    const landscape = cells.find((c) => (aspects[c.index] ?? 0) >= 1);
    expect(portrait && landscape && portrait.height > landscape.height).toBe(true);
  });

  it("never zooms an orphan: a lone portrait finds its partner beyond the window", () => {
    // The only partner sits past the packing window (16): the packing must look further, not blow the portrait up.
    const aspects = [2 / 3, ...Array<number>(20).fill(1.5), 2 / 3];
    const bands = bandedMosaic(aspects, W, L);
    const nominal = Math.hypot(1.5, 1) * L;
    for (const band of bands.slice(0, -1)) {
      for (const cell of band.cells) {
        expect(Math.hypot(cell.width, cell.height)).toBeLessThan(nominal * 1.25);
      }
    }
  });

  it("shares a mixed column when no partner exists at all, rather than doubling", () => {
    const aspects = [2 / 3, ...Array<number>(11).fill(1.5)];
    const bands = bandedMosaic(aspects, W, L);
    const nominal = Math.hypot(1.5, 1) * L;
    const portrait = bands
      .flatMap((b) => b.cells)
      .find((c) => (aspects[c.index] ?? 0) < 1);
    expect(portrait).toBeDefined();
    if (portrait) {
      expect(Math.hypot(portrait.width, portrait.height)).toBeLessThan(nominal * 1.25);
    }
  });

  it("keeps chronology as the anchor: the first cell is the first photograph", () => {
    const aspects = [2 / 3, 1.5, 1.5, 2 / 3, 1.5, 2 / 3, 1.5];
    const bands = bandedMosaic(aspects, W, L);
    expect(bands[0]?.cells[0]?.index).toBe(0);
  });

  it("pairs squares exactly and leaves no hole under a lone tall crop", () => {
    const aspects = [1, 1, 1, 1, 0.44, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5];
    const bands = bandedMosaic(aspects, W, L);
    for (const band of bands.slice(0, -1)) {
      const area = band.cells.reduce((sum, c) => sum + c.width * c.height, 0);
      expect(area).toBe(W * band.height);
    }
  });
});

describe("vertical neighbor", () => {
  it("drops into the next justified row near the same spot", () => {
    const rows = mosaicRows(Array<number>(8).fill(1.5), 900, 180, 0);
    const bands = rowsToBands(rows);
    const perRow = rows[0]?.count ?? 0;
    expect(perRow).toBeGreaterThan(1);
    expect(verticalNeighbor(bands, 0, 1)).toBe(perRow);
    expect(verticalNeighbor(bands, perRow, -1)).toBe(0);
  });

  it("walks a banded stack cell by cell before leaving the band", () => {
    // All landscapes pack as three-high columns; below the top cell is the same column's middle, not the next band.
    const bands = bandedMosaic(Array<number>(24).fill(1.5), 1200, 180);
    const first = bands[0];
    const top = first?.cells.find((c) => c.y === 0);
    expect(top).toBeDefined();
    if (top === undefined) return;
    const below = verticalNeighbor(bands, top.index, 1);
    const target = first?.cells.find((c) => c.index === below);
    // Same column: same left edge, starting where the top cell ends.
    expect(target?.x).toBe(top.x);
    expect(target?.y).toBe(top.height);
  });

  it("returns null past the top and bottom edges", () => {
    const bands = rowsToBands(mosaicRows([1.5, 1.5], 400, 180, 0));
    expect(verticalNeighbor(bands, 0, -1)).toBeNull();
    expect(verticalNeighbor(bands, 0, 1)).toBeNull();
  });
});

describe("rows as bands", () => {
  it("re-expresses justified rows losslessly", () => {
    const rows = mosaicRows([1.5, 0.66, 1.5, 1.5, 0.66, 1.5], 900, 180, 0);
    const bands = rowsToBands(rows);
    expect(bands).toHaveLength(rows.length);
    for (const [i, band] of bands.entries()) {
      const row = rows[i];
      expect(band.height).toBe(row?.height);
      expect(band.cells.map((c) => c.width)).toEqual(row?.widths);
      expect(band.cells.map((c) => c.index)).toEqual(
        row?.widths.map((_, j) => (row?.firstIndex ?? 0) + j),
      );
    }
  });
});
