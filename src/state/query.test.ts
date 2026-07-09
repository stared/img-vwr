import { beforeAll, describe, expect, it } from "vitest";

import type { FileEntry, ImageMeta } from "../ipc";
import { clearSortsForTest, registerSort, sortsFor } from "../registry/sorts";
import { registerBuiltinSorts } from "../sorts/builtin";
import {
  applyQuery,
  dateInputValue,
  defaultQuery,
  rangeFromInput,
  usesMeta,
  withAspectToggled,
  withCameraSet,
  withCameraToggled,
  withFormatToggled,
  withNameFilter,
  withoutFilters,
  withoutFormats,
  withRangeSet,
  withRangeToggled,
  withSort,
} from "./query";

// Sort behavior lives in the registry; the engine tests need the built-ins
// plus one source-style order (position in the collection as delivered).
beforeAll(() => {
  clearSortsForTest();
  registerBuiltinSorts();
  registerSort({
    id: "test.rank",
    label: "rank",
    defaultDir: "asc",
    appliesTo: (scope) => scope?.kind === "source",
    value: (_entry, ctx) => ctx.sourceIndex,
  });
});

function entry(name: string, ext: string, size: number, modifiedMs: number): FileEntry {
  return { path: `/p/${name}`, name, formatHint: ext, size, modifiedMs };
}

function imageMeta(overrides: Partial<ImageMeta>): ImageMeta {
  return {
    width: 4000,
    height: 3000,
    format: "jpg",
    fileSize: 300,
    modifiedMs: 0,
    exif: null,
    ...overrides,
  };
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

  it("a registered source order sorts by delivery position, surviving filters", () => {
    const byRank = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "test.rank", dir: "asc" } });
    expect(byRank.map((e) => e.name)).toEqual(["beach2.jpg", "beach10.jpg", "Alps.png", "zoo.webp"]);
    // Positions are assigned before filtering, so rank is stable under filters.
    const filtered = applyQuery(ENTRIES, {
      ...withFormatToggled(defaultQuery, "jpeg"),
      sort: { key: "test.rank", dir: "desc" },
    });
    expect(filtered.map((e) => e.name)).toEqual(["beach10.jpg", "beach2.jpg"]);
  });

  it("an unknown sort key falls back to name order", () => {
    const names = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "gone.plugin", dir: "asc" } });
    expect(names.map((e) => e.name)).toEqual(["Alps.png", "beach2.jpg", "beach10.jpg", "zoo.webp"]);
  });

  it("sortsFor filters providers by scope", () => {
    const folderIds = sortsFor({ kind: "folder", path: "/p" }).map((p) => p.id);
    expect(folderIds).toEqual(["name", "modified", "size"]);
    const sourceIds = sortsFor({ kind: "source", sourceId: "x", arg: "", label: "" }).map(
      (p) => p.id,
    );
    expect(sourceIds).toContain("test.rank");
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

  it("camera filter matches only images whose metadata is known", () => {
    const meta = {
      "/p/beach2.jpg": imageMeta({
        exif: { orientation: 1, dateTime: null, camera: "iPhone SE", gpsLat: null, gpsLon: null },
      }),
    };
    const query = withCameraToggled(defaultQuery, "iPhone SE");
    expect(applyQuery(ENTRIES, query, meta).map((e) => e.name)).toEqual(["beach2.jpg"]);
    // No metadata at all → nothing can match yet.
    expect(applyQuery(ENTRIES, query)).toEqual([]);
  });

  it("aspect filter snaps dimensions, honoring EXIF rotation", () => {
    const meta = {
      "/p/beach2.jpg": imageMeta({ width: 4000, height: 3000 }), // 4:3
      "/p/Alps.png": imageMeta({
        width: 4000,
        height: 3000,
        exif: { orientation: 6, dateTime: null, camera: null, gpsLat: null, gpsLon: null }, // rotated, still 4:3
      }),
      "/p/zoo.webp": imageMeta({ width: 3000, height: 2000 }), // 3:2
    };
    const query = withAspectToggled(defaultQuery, "4:3");
    expect(applyQuery(ENTRIES, query, meta).map((e) => e.name)).toEqual([
      "Alps.png",
      "beach2.jpg",
    ]);
  });

  it("range filters are half-open and field-specific", () => {
    const bySize = withRangeToggled(defaultQuery, "size", 200, 400, "200–400");
    expect(applyQuery(ENTRIES, bySize).map((e) => e.size)).toEqual([200, 300]);

    const byModified = withRangeToggled(defaultQuery, "modified", 1_000, 2_000, "old");
    expect(applyQuery(ENTRIES, byModified).map((e) => e.name)).toEqual(["beach10.jpg"]);

    const byEdge = withRangeToggled(defaultQuery, "edge", 3900, 4100, "≈4000");
    const meta = { "/p/zoo.webp": imageMeta({ width: 3000, height: 4000 }) };
    expect(applyQuery(ENTRIES, byEdge, meta).map((e) => e.name)).toEqual(["zoo.webp"]);
  });

  it("usesMeta is true only for metadata-dependent filters", () => {
    expect(usesMeta(defaultQuery)).toBe(false);
    expect(usesMeta(withRangeToggled(defaultQuery, "size", 0, 1, "x"))).toBe(false);
    expect(usesMeta(withRangeToggled(defaultQuery, "taken", 0, 1, "x"))).toBe(true);
    expect(usesMeta(withCameraToggled(defaultQuery, "X"))).toBe(true);
    expect(usesMeta(withAspectToggled(defaultQuery, "4:3"))).toBe(true);
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

  it("value toggles set, switch, and clear their clause", () => {
    const one = withCameraToggled(defaultQuery, "A");
    expect(one.filters).toEqual([{ kind: "camera", camera: "A" }]);
    // Another value switches the clause rather than stacking a second one.
    const switched = withCameraToggled(one, "B");
    expect(switched.filters).toEqual([{ kind: "camera", camera: "B" }]);
    // The active value clears it.
    expect(withCameraToggled(switched, "B").filters).toEqual([]);
  });

  it("range toggles are keyed by field", () => {
    const size = withRangeToggled(defaultQuery, "size", 0, 100, "small");
    const both = withRangeToggled(size, "taken", 5, 10, "then");
    expect(both.filters).toHaveLength(2);
    // Same field replaces; same field + same range clears.
    const replaced = withRangeToggled(both, "size", 100, 200, "medium");
    expect(replaced.filters.filter((f) => f.kind === "range")).toHaveLength(2);
    const cleared = withRangeToggled(replaced, "size", 100, 200, "medium");
    expect(cleared.filters).toEqual([{ kind: "range", field: "taken", from: 5, to: 10, label: "then" }]);
  });

  it("set variants replace their clause without ever clearing", () => {
    const one = withCameraSet(defaultQuery, "A");
    expect(withCameraSet(one, "A").filters).toEqual([{ kind: "camera", camera: "A" }]);
    expect(withCameraSet(one, "B").filters).toEqual([{ kind: "camera", camera: "B" }]);
    const sized = withRangeSet(defaultQuery, "size", 0, 100, "small");
    const resized = withRangeSet(sized, "size", 0, 100, "small");
    expect(resized.filters).toHaveLength(1);
  });

  it("empty name filter removes itself; withoutFilters keeps sort", () => {
    const q = withNameFilter(withSort(defaultQuery, "size"), "");
    expect(q.filters).toEqual([]);
    const cleared = withoutFilters(withNameFilter(q, "x"));
    expect(cleared.filters).toEqual([]);
    expect(cleared.sort.key).toBe("size");
  });
});

describe("rangeFromInput", () => {
  it("dates are day-granular and inclusive at both operators", () => {
    const day = new Date(2024, 2, 5).getTime();
    const next = new Date(2024, 2, 6).getTime();
    expect(rangeFromInput("taken", ">=", "2024-03-05")).toEqual({
      from: day,
      to: Infinity,
      label: "≥ 2024-03-05",
    });
    expect(rangeFromInput("taken", "<=", "2024-03-05")).toEqual({
      from: -Infinity,
      to: next,
      label: "≤ 2024-03-05",
    });
    expect(rangeFromInput("modified", "=", "2024-03-05")).toEqual({
      from: day,
      to: next,
      label: "= 2024-03-05",
    });
  });

  it("sizes are decimal megabytes, edges whole pixels", () => {
    expect(rangeFromInput("size", ">=", "2.5")).toEqual({
      from: 2_500_000,
      to: Infinity,
      label: "≥ 2.5 MB",
    });
    expect(rangeFromInput("edge", "=", "4032")).toEqual({
      from: 4032,
      to: 4033,
      label: "= 4032 px",
    });
    expect(rangeFromInput("edge", "<=", "1000")?.to).toBe(1001);
  });

  it("rejects unparsable input", () => {
    expect(rangeFromInput("taken", ">=", "yesterday")).toBeNull();
    expect(rangeFromInput("size", ">=", "")).toBeNull();
    expect(rangeFromInput("edge", ">=", "-5")).toBeNull();
  });

  it("dateInputValue round-trips a local day", () => {
    expect(dateInputValue(new Date(2024, 2, 5).getTime())).toBe("2024-03-05");
  });
});
