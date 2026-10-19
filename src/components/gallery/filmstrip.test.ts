import { describe, expect, it } from "vitest";

import type { FileEntry } from "../../ipc";
import { stripCells, stripLayout, stripRange } from "./Filmstrip";

// Height 160: cells `height - 12` wide, 6 px gap.
const W = 148;
const uniform = (n: number) => stripLayout(Array(n).fill(false), W).lefts;

describe("stripLayout", () => {
  it("adds a stacked cell's margin to every cell after it", () => {
    const { lefts, total } = stripLayout([false, true, false], W);
    expect(lefts).toEqual([0, 160, 314]);
    expect(total).toBe(314 + W);
  });
});

describe("stripRange", () => {
  it("covers what is on screen, deep into a long strip", () => {
    const { first, last } = stripRange(uniform(170), W, { scrollLeft: 117 * 154, clientWidth: 1540 });
    expect(first).toBeLessThanOrEqual(117);
    expect(last).toBeGreaterThanOrEqual(127);
    // Only what is near the viewport is mounted.
    expect(last - first).toBeLessThan(30);
  });

  it("starts at the beginning when the strip has not been scrolled", () => {
    expect(stripRange(uniform(170), W, { scrollLeft: 0, clientWidth: 1540 }).first).toBe(0);
  });

  it("never runs past either end", () => {
    expect(stripRange(uniform(10), W, { scrollLeft: -20, clientWidth: 100 }).first).toBe(0);
    expect(stripRange(uniform(10), W, { scrollLeft: 99_000, clientWidth: 1540 }).last).toBe(10);
  });

  it("is empty for an empty strip", () => {
    expect(stripRange([], W, { scrollLeft: 0, clientWidth: 800 })).toEqual({ first: 0, last: 0 });
  });
});

const file = (name: string): FileEntry => ({
  path: `/shoot/${name}`,
  name,
  size: 1,
  modifiedMs: 0,
  formatHint: name.slice(name.lastIndexOf(".") + 1).toLowerCase(),
});

// A raw+JPEG pair and a lone frame; `visible` is the collapsed list.
const rawOfPair = file("DSC_0001.NEF");
const jpgOfPair = file("DSC_0001.JPG");
const lone = file("DSC_0002.JPG");
const all = [rawOfPair, jpgOfPair, lone];
const visible = [jpgOfPair, lone];
const pairKey = "/shoot/DSC_0001";

describe("stripCells", () => {
  it("is the visible list, one cell per photograph, while nothing is spread", () => {
    const cells = stripCells(visible, all, {}, true);
    expect(cells.map((c) => c.entry.path)).toEqual(visible.map((e) => e.path));
    expect(cells.map((c) => c.index)).toEqual([0, 1]);
  });

  it("spreads a raw+JPEG pair in name order however the disk listed it, keeping the shown one's index", () => {
    const cells = stripCells(visible, all, { [pairKey]: true }, true);
    expect(cells.map((c) => c.entry.name)).toEqual(["DSC_0001.JPG", "DSC_0001.NEF", "DSC_0002.JPG"]);
    // The shown member keeps its visible index; the extras are addressed by path, not index.
    expect(cells.map((c) => c.index)).toEqual([0, null, 1]);
    // Every spread cell still belongs to the one photograph.
    expect(new Set(cells.slice(0, 2).map((c) => c.key))).toEqual(new Set([pairKey]));
  });

  it("ignores a spread that no longer names a pile, and all of them with stacking off", () => {
    const cells = stripCells([lone], [lone], { "/shoot/DSC_0002": true }, true);
    expect(cells).toEqual([{ entry: lone, index: 0, key: "/shoot/DSC_0002" }]);
    const flat = stripCells(all, all, { [pairKey]: true }, false);
    expect(flat).toHaveLength(all.length);
    expect(flat.every((c) => c.index !== null)).toBe(true);
  });
});
