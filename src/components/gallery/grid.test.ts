import { describe, expect, it } from "vitest";

import { cellSizeFor, maxColumnsFor } from "./GalleryGrid";

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
