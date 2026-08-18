import { describe, expect, it } from "vitest";

import { cellSizeFor, gridRows, maxColumnsFor, rowNeighbor } from "./GalleryGrid";

describe("maxColumnsFor", () => {
  it("scales the limit with the viewport rather than fixing it", () => {
    expect(maxColumnsFor(1000)).toBeGreaterThan(maxColumnsFor(500));
  });

  it("never offers fewer than two columns, however narrow", () => {
    expect(maxColumnsFor(0)).toBe(2);
    expect(maxColumnsFor(50)).toBe(2);
  });

  it("keeps the widest setting above the size a photo stops reading at", () => {
    for (const width of [400, 900, 1600, 3000]) {
      expect(cellSizeFor(width, maxColumnsFor(width))).toBeGreaterThanOrEqual(96);
    }
  });
});

describe("cellSizeFor", () => {
  it("fills the width, gaps included", () => {
    // 4 cells and 3 gaps of 8px across 1000px.
    expect(cellSizeFor(1000, 4)).toBe(Math.floor((1000 - 24) / 4));
  });

  it("gives bigger cells as the column count drops", () => {
    expect(cellSizeFor(1200, 3)).toBeGreaterThan(cellSizeFor(1200, 8));
  });

  it("stops shrinking at the readable minimum", () => {
    expect(cellSizeFor(300, 20)).toBe(96);
  });
});

describe("rowNeighbor", () => {
  // 10 photos, 4 per row: rows [0..3] [4..7] [8..9].
  const rows = gridRows(10, null, 4);

  it("moves straight down and up a column", () => {
    expect(rowNeighbor(rows, 1, 1)).toBe(5);
    expect(rowNeighbor(rows, 5, -1)).toBe(1);
  });

  it("clamps into a short last row rather than overshooting", () => {
    expect(rowNeighbor(rows, 7, 1)).toBe(9);
  });

  it("stays put at the edges", () => {
    expect(rowNeighbor(rows, 2, -1)).toBeNull();
    expect(rowNeighbor(rows, 9, 1)).toBeNull();
  });

  it("steps over scene headers, keeping the column", () => {
    const scenes = [
      { start: 0, end: 4, startMs: 0 },
      { start: 4, end: 10, startMs: 3_600_000 },
    ];
    const withHeaders = gridRows(10, scenes, 4);
    expect(rowNeighbor(withHeaders, 1, 1)).toBe(5);
    expect(rowNeighbor(withHeaders, 5, -1)).toBe(1);
  });
});
