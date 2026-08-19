import { describe, expect, it } from "vitest";

import type { FileEntry } from "../../ipc";
import { stripCells, stripRange } from "./Filmstrip";

// The numbers Filmstrip's CSS actually produces at height 160: cells `height - 12` wide, 6 px gap, 8 px padding.
const layout = { origin: 8, pitch: 154 };

describe("stripRange", () => {
  it("covers what is on screen, deep into a long strip", () => {
    // Guards: a pitch guessed as `height + 6` (166) put the requested window nine cells past the visible one.
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

const file = (name: string): FileEntry => ({
  path: `/shoot/${name}`,
  name,
  size: 1,
  modifiedMs: 0,
  formatHint: name.slice(name.lastIndexOf(".") + 1).toLowerCase(),
});

// A raw+JPEG pair, a lone frame, and a three-frame HDR set fronted by its face; `visible` is the collapsed list.
const rawOfPair = file("DSC_0001.NEF");
const jpgOfPair = file("DSC_0001.JPG");
const lone = file("DSC_0002.JPG");
const face = file("DSC_0004.JPG");
const bracket = [file("DSC_0003.JPG"), face, file("DSC_0005.JPG")];
const all = [rawOfPair, jpgOfPair, lone, ...bracket];
const hdrKeys = new Map(bracket.map((f) => [`/shoot/${f.name.slice(0, -4)}`, face.path]));
const visible = [jpgOfPair, lone, face];

describe("stripCells", () => {
  it("is the visible list, one cell per photograph, while nothing is spread", () => {
    const cells = stripCells(visible, all, {}, hdrKeys, true);
    expect(cells.map((c) => c.entry.path)).toEqual(visible.map((e) => e.path));
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("spreads a stack into its members in name order, keeping the shown one's index", () => {
    const cells = stripCells(visible, all, { [face.path]: true }, hdrKeys, true);
    expect(cells.map((c) => c.entry.name)).toEqual([
      "DSC_0001.JPG",
      "DSC_0002.JPG",
      "DSC_0003.JPG",
      "DSC_0004.JPG",
      "DSC_0005.JPG",
    ]);
    // The shown member keeps its visible index; the extras are addressed by path, not index.
    expect(cells.map((c) => c.index)).toEqual([0, 1, null, 2, null]);
    // Every spread cell still belongs to the one photograph.
    expect(new Set(cells.slice(2).map((c) => c.key))).toEqual(new Set([face.path]));
  });

  it("spreads a raw+JPEG pair the same way, in name order however the disk listed it", () => {
    const key = "/shoot/DSC_0001";
    const cells = stripCells(visible, all, { [key]: true }, hdrKeys, true);
    expect(cells.map((c) => c.entry.name)).toEqual([
      "DSC_0001.JPG",
      "DSC_0001.NEF",
      "DSC_0002.JPG",
      "DSC_0004.JPG",
    ]);
    expect(cells.map((c) => c.index)).toEqual([0, null, 1, 2]);
  });

  it("ignores a spread that no longer names a pile, and all of them with stacking off", () => {
    const cells = stripCells([lone], [lone], { "/shoot/DSC_0002": true }, null, true);
    expect(cells).toEqual([{ entry: lone, index: 0, key: "/shoot/DSC_0002" }]);
    const flat = stripCells(all, all, { [face.path]: true }, hdrKeys, false);
    expect(flat).toHaveLength(all.length);
    expect(flat.every((c) => c.index !== null)).toBe(true);
  });
});
