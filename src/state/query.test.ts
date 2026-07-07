import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import {
  applyQuery,
  defaultQuery,
  withFormatToggled,
  withNameFilter,
  withoutFilters,
  withoutFormats,
  withSort,
} from "./query";

function entry(name: string, ext: string, size: number, modifiedMs: number): FileEntry {
  return { path: `/p/${name}`, name, formatHint: ext, size, modifiedMs };
}

const ENTRIES: FileEntry[] = [
  entry("beach2.jpg", "jpg", 300, 3_000),
  entry("beach10.jpg", "jpg", 100, 1_000),
  entry("Alps.png", "png", 200, 2_000),
  entry("zoo.webp", "webp", 400, 4_000),
];

describe("applyQuery", () => {
  it("default: natural name sort, case-insensitive, no filtering", () => {
    const names = applyQuery(ENTRIES, defaultQuery).map((e) => e.name);
    expect(names).toEqual(["Alps.png", "beach2.jpg", "beach10.jpg", "zoo.webp"]);
  });

  it("sorts by modified desc (newest first) and size", () => {
    const byDate = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "modified", dir: "desc" } });
    expect(byDate[0]?.name).toBe("zoo.webp");
    const bySize = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "size", dir: "asc" } });
    expect(bySize.map((e) => e.size)).toEqual([100, 200, 300, 400]);
  });

  it("format filter groups jpg and jpeg, filters compose with AND", () => {
    const jpegs = applyQuery(ENTRIES, withFormatToggled(defaultQuery, "jpeg"));
    expect(jpegs.map((e) => e.formatHint)).toEqual(["jpg", "jpg"]);

    const composed = applyQuery(
      ENTRIES,
      withNameFilter(withFormatToggled(defaultQuery, "jpeg"), "10"),
    );
    expect(composed.map((e) => e.name)).toEqual(["beach10.jpg"]);
  });

  it("name filter is case-insensitive substring", () => {
    const found = applyQuery(ENTRIES, withNameFilter(defaultQuery, "ALPS"));
    expect(found.map((e) => e.name)).toEqual(["Alps.png"]);
  });
});

describe("query editing", () => {
  it("withSort flips direction on repeat, uses opinionated default first", () => {
    const byDate = withSort(defaultQuery, "modified");
    expect(byDate.sort).toEqual({ key: "modified", dir: "desc" });
    expect(withSort(byDate, "modified").sort.dir).toBe("asc");
  });

  it("withFormatToggled adds, extends, and removes the format filter", () => {
    const one = withFormatToggled(defaultQuery, "png");
    const two = withFormatToggled(one, "gif");
    expect(applyQuery(ENTRIES, two).map((e) => e.name)).toEqual(["Alps.png"]);
    const none = withFormatToggled(withFormatToggled(two, "gif"), "png");
    expect(none.filters).toEqual([]);
  });

  it("withoutFormats drops only the format filter", () => {
    const q = withNameFilter(withFormatToggled(defaultQuery, "png"), "x");
    const stripped = withoutFormats(q);
    expect(stripped.filters).toEqual([{ kind: "name", substring: "x" }]);
  });

  it("empty name filter removes itself; withoutFilters keeps sort", () => {
    const q = withNameFilter(withSort(defaultQuery, "size"), "");
    expect(q.filters).toEqual([]);
    const cleared = withoutFilters(withNameFilter(q, "x"));
    expect(cleared.filters).toEqual([]);
    expect(cleared.sort.key).toBe("size");
  });
});
