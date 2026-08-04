import { beforeAll, describe, expect, it } from "vitest";

import type { FileEntry, ImageMeta } from "../ipc";
import { clearFilterFieldsForTest, registerFilterField } from "../registry/filters";
import { clearSortsForTest, registerSort, sortsFor } from "../registry/sorts";
import { registerBuiltinSorts } from "../sorts/builtin";
import { aspectLabelOf, effectiveDims, takenMs } from "./derived";
import type { QueryData } from "./query";
import {
  applyQuery,
  dateInputValue,
  dateRangeSpec,
  defaultQuery,
  numberRangeSpec,
  rangeFromInput,
  usesLabels,
  usesMeta,
  formatChoices,
  withFormatToggled,
  withNameFilter,
  withoutFilters,
  withoutFormats,
  withRangeSet,
  withRangeToggled,
  withSelectSet,
  withSelectToggled,
  withSort,
} from "./query";

// Sort and filter behavior lives in the registries; the engine tests
// exercise them through registered fields — the same seam plugins use.
beforeAll(() => {
  clearSortsForTest();
  registerBuiltinSorts();
  registerSort({
    id: "test.rank",
    label: "rank",
    hints: { asc: "as delivered", desc: "reversed" },
    defaultDir: "asc",
    appliesTo: (scope) => scope?.kind === "source",
    reads: "entry",
    missing: "last",
    param: null,
    value: (_entry, ctx) => ctx.sourceIndex,
  });
  registerSort({
    id: "test.score",
    label: "score",
    hints: { asc: "lowest", desc: "highest" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "scores",
    missing: "hide",
    param: null,
    value: (entry, ctx) => ctx.scores[entry.path] ?? null,
  });

  const NoMenu = () => null;
  clearFilterFieldsForTest();
  registerFilterField({
    kind: "select",
    id: "camera",
    label: "camera",
    appliesTo: () => true,
    reads: "meta",
    Menu: NoMenu,
    value: (_entry, { meta }) => meta?.exif?.camera ?? null,
  });
  registerFilterField({
    kind: "select",
    id: "aspect",
    label: "aspect",
    appliesTo: () => true,
    reads: "meta",
    Menu: NoMenu,
    value: (_entry, { meta }) => {
      const dims = meta ? effectiveDims(meta) : null;
      return dims ? aspectLabelOf(dims) : null;
    },
  });
  registerFilterField({
    kind: "range",
    id: "taken",
    label: "taken",
    appliesTo: () => true,
    reads: "meta",
    Menu: NoMenu,
    spec: dateRangeSpec((_entry, { meta }) => (meta ? takenMs(meta) : null)),
  });
  registerFilterField({
    kind: "range",
    id: "modified",
    label: "modified",
    appliesTo: () => true,
    reads: "entry",
    Menu: NoMenu,
    spec: dateRangeSpec((entry) => entry.modifiedMs),
  });
  registerFilterField({
    kind: "range",
    id: "size",
    label: "size",
    appliesTo: () => true,
    reads: "entry",
    Menu: NoMenu,
    spec: numberRangeSpec((entry) => entry.size, {
      unit: "MB",
      scale: 1e6,
      integer: false,
      ops: ["<=", ">="],
    }),
  });
  registerFilterField({
    kind: "range",
    id: "edge",
    label: "longest edge",
    appliesTo: () => true,
    reads: "meta",
    Menu: NoMenu,
    spec: numberRangeSpec(
      (_entry, { meta }) => {
        const dims = meta ? effectiveDims(meta) : null;
        return dims ? Math.max(dims.width, dims.height) : null;
      },
      { unit: "px", scale: 1, integer: true, ops: ["<=", "=", ">="] },
    ),
  });
  // Label-backed fields, registered the same way the labels module does.
  registerFilterField({
    kind: "range",
    id: "stars",
    label: "stars",
    appliesTo: () => true,
    reads: "labels",
    Menu: NoMenu,
    spec: numberRangeSpec((_entry, { labels }) => labels.stars, {
      unit: "★",
      scale: 1,
      integer: true,
      ops: ["<=", "=", ">="],
    }),
  });
  registerFilterField({
    kind: "flags",
    id: "tag",
    label: "tag",
    appliesTo: () => true,
    reads: "labels",
    Menu: NoMenu,
    values: (_entry, { labels }) => labels.tags,
  });
  registerSort({
    id: "stars",
    label: "stars",
    hints: { asc: "lowest rated", desc: "highest rated" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "labels",
    missing: "last",
    param: null,
    value: (_entry, ctx) => ctx.labels.stars,
  });
});

/** QueryData with every channel empty unless a test provides it. */
function data(part: Partial<QueryData> = {}): QueryData {
  return { meta: {}, scores: {}, labels: {}, ...part };
}

function entry(name: string, ext: string, size: number, modifiedMs: number): FileEntry {
  return { path: `/p/${name}`, name, formatHint: ext, size, modifiedMs };
}

/* Every field: ExifSubset is a total contract, so a fixture must say what
 * the photograph does not carry as well as what it does. */
const NO_EXIF = {
  orientation: 1,
  dateTime: null,
  camera: null,
  lens: null,
  exposureTime: null,
  fNumber: null,
  iso: null,
  focalLength: null,
  gpsLat: null,
  gpsLon: null,
};

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
    const names = applyQuery(ENTRIES, defaultQuery, data()).map((e) => e.name);
    expect(names).toEqual(["Alps.png", "beach2.jpg", "beach10.jpg", "zoo.webp"]);
  });

  it("sorts by modified desc (newest first) and size", () => {
    const byDate = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "modified", dir: "desc" } }, data());
    expect(byDate[0]?.name).toBe("zoo.webp");
    const bySize = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "size", dir: "asc" } }, data());
    expect(bySize.map((e) => e.size)).toEqual([100, 200, 300, 400]);
  });

  it("a registered source order sorts by delivery position, surviving filters", () => {
    const byRank = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "test.rank", dir: "asc" } }, data());
    expect(byRank.map((e) => e.name)).toEqual(["beach2.jpg", "beach10.jpg", "Alps.png", "zoo.webp"]);
    // Positions are assigned before filtering, so rank is stable under filters.
    const filtered = applyQuery(
      ENTRIES,
      { ...withFormatToggled(defaultQuery, "jpeg"), sort: { key: "test.rank", dir: "desc" } },
      data(),
    );
    expect(filtered.map((e) => e.name)).toEqual(["beach10.jpg", "beach2.jpg"]);
  });

  it("a hide-missing scores sort shows ONLY ranked entries", () => {
    const scores = { "/p/zoo.webp": 0.9, "/p/Alps.png": 0.4 };
    const ranked = applyQuery(
      ENTRIES,
      { ...defaultQuery, sort: { key: "test.score", dir: "desc" } },
      data({ scores }),
    );
    // Unscored entries are excluded entirely; they appear as scores land.
    expect(ranked.map((e) => e.name)).toEqual(["zoo.webp", "Alps.png"]);
    expect(
      applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "test.score", dir: "desc" } }, data()),
    ).toEqual([]);
  });

  it("an unknown sort key falls back to name order", () => {
    const names = applyQuery(ENTRIES, { ...defaultQuery, sort: { key: "gone.plugin", dir: "asc" } }, data());
    expect(names.map((e) => e.name)).toEqual(["Alps.png", "beach2.jpg", "beach10.jpg", "zoo.webp"]);
  });

  it("sortsFor filters providers by scope", () => {
    const folderIds = sortsFor({ kind: "folder", path: "/p", recursive: false }).map((p) => p.id);
    expect(folderIds).toEqual(expect.arrayContaining(["name", "modified", "size"]));
    expect(folderIds).not.toContain("test.rank");
    const sourceIds = sortsFor({ kind: "source", sourceId: "x", arg: "", label: "" }).map(
      (p) => p.id,
    );
    expect(sourceIds).toContain("test.rank");
  });

  it("format filter groups jpg and jpeg, filters compose with AND", () => {
    const jpegs = applyQuery(ENTRIES, withFormatToggled(defaultQuery, "jpeg"), data());
    expect(jpegs.map((e) => e.formatHint)).toEqual(["jpg", "jpg"]);

    const composed = applyQuery(
      ENTRIES,
      withNameFilter(withFormatToggled(defaultQuery, "jpeg"), "10"),
      data(),
    );
    expect(composed.map((e) => e.name)).toEqual(["beach10.jpg"]);
  });

  it("name filter is case-insensitive substring", () => {
    const found = applyQuery(ENTRIES, withNameFilter(defaultQuery, "ALPS"), data());
    expect(found.map((e) => e.name)).toEqual(["Alps.png"]);
  });

  it("camera filter matches only images whose metadata is known", () => {
    const meta = {
      "/p/beach2.jpg": imageMeta({
        exif: { ...NO_EXIF, orientation: 1, dateTime: null, camera: "iPhone SE", gpsLat: null, gpsLon: null },
      }),
    };
    const query = withSelectToggled(defaultQuery, "camera", "iPhone SE");
    expect(applyQuery(ENTRIES, query, data({ meta })).map((e) => e.name)).toEqual(["beach2.jpg"]);
    // No metadata at all → nothing can match yet.
    expect(applyQuery(ENTRIES, query, data())).toEqual([]);
  });

  it("aspect filter snaps dimensions, honoring EXIF rotation", () => {
    const meta = {
      "/p/beach2.jpg": imageMeta({ width: 4000, height: 3000 }), // 4:3
      "/p/Alps.png": imageMeta({
        width: 4000,
        height: 3000,
        exif: { ...NO_EXIF, orientation: 6 }, // rotated, still 4:3
      }),
      "/p/zoo.webp": imageMeta({ width: 3000, height: 2000 }), // 3:2
    };
    const query = withSelectToggled(defaultQuery, "aspect", "4:3");
    expect(applyQuery(ENTRIES, query, data({ meta })).map((e) => e.name)).toEqual([
      "Alps.png",
      "beach2.jpg",
    ]);
  });

  it("range filters are half-open and field-specific", () => {
    const bySize = withRangeToggled(defaultQuery, "size", 200, 400, "200–400");
    expect(applyQuery(ENTRIES, bySize, data()).map((e) => e.size)).toEqual([200, 300]);

    const byModified = withRangeToggled(defaultQuery, "modified", 1_000, 2_000, "old");
    expect(applyQuery(ENTRIES, byModified, data()).map((e) => e.name)).toEqual(["beach10.jpg"]);

    const byEdge = withRangeToggled(defaultQuery, "edge", 3900, 4100, "≈4000");
    const meta = { "/p/zoo.webp": imageMeta({ width: 3000, height: 4000 }) };
    expect(applyQuery(ENTRIES, byEdge, data({ meta })).map((e) => e.name)).toEqual(["zoo.webp"]);
  });

  it("a clause on an unregistered field matches nothing, not everything", () => {
    const query = withSelectToggled(defaultQuery, "gone.plugin", "x");
    expect(applyQuery(ENTRIES, query, data())).toEqual([]);
  });

  it("usesMeta is true only for metadata-dependent filters", () => {
    expect(usesMeta(defaultQuery)).toBe(false);
    expect(usesMeta(withRangeToggled(defaultQuery, "size", 0, 1, "x"))).toBe(false);
    expect(usesMeta(withRangeToggled(defaultQuery, "taken", 0, 1, "x"))).toBe(true);
    expect(usesMeta(withSelectToggled(defaultQuery, "camera", "X"))).toBe(true);
    expect(usesMeta(withSelectToggled(defaultQuery, "aspect", "4:3"))).toBe(true);
  });

  it("stars range filter reads labels; unrated images never match", () => {
    const labels = {
      "/p/beach2.jpg": { stars: 4, tags: [] },
      "/p/Alps.png": { stars: 2, tags: [] },
    };
    const atLeast3 = withRangeToggled(defaultQuery, "stars", 3, Infinity, "≥ 3 ★");
    expect(applyQuery(ENTRIES, atLeast3, data({ labels })).map((e) => e.name)).toEqual([
      "beach2.jpg",
    ]);
    // Nothing rated → nothing matches.
    expect(applyQuery(ENTRIES, atLeast3, data())).toEqual([]);
  });

  it("a tag clause (select on a flags field) matches on membership", () => {
    const labels = {
      "/p/beach2.jpg": { stars: null, tags: ["sea", "pair"] },
      "/p/zoo.webp": { stars: null, tags: ["animals"] },
    };
    const tagged = withSelectToggled(defaultQuery, "tag", "sea");
    expect(applyQuery(ENTRIES, tagged, data({ labels })).map((e) => e.name)).toEqual([
      "beach2.jpg",
    ]);
    expect(applyQuery(ENTRIES, tagged, data())).toEqual([]);
  });

  it("stars sort ranks rated images first, unrated last in name order", () => {
    const labels = {
      "/p/Alps.png": { stars: 2, tags: [] },
      "/p/zoo.webp": { stars: 5, tags: [] },
    };
    const byStars = applyQuery(
      ENTRIES,
      { ...defaultQuery, sort: { key: "stars", dir: "desc" } },
      data({ labels }),
    );
    expect(byStars.map((e) => e.name)).toEqual([
      "zoo.webp",
      "Alps.png",
      "beach2.jpg",
      "beach10.jpg",
    ]);
  });

  it("usesLabels is true for label-backed clauses and the stars sort", () => {
    expect(usesLabels(defaultQuery)).toBe(false);
    expect(usesLabels(withRangeToggled(defaultQuery, "stars", 3, Infinity, "x"))).toBe(true);
    expect(usesLabels(withSelectToggled(defaultQuery, "tag", "sea"))).toBe(true);
    expect(usesLabels({ ...defaultQuery, sort: { key: "stars", dir: "desc" } })).toBe(true);
    expect(usesLabels(withSelectToggled(defaultQuery, "camera", "X"))).toBe(false);
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
    expect(applyQuery(ENTRIES, two, data()).map((e) => e.name)).toEqual(["Alps.png"]);
    const none = withFormatToggled(withFormatToggled(two, "gif"), "png");
    expect(none.filters).toEqual([]);
  });

  it("filters formats nobody bothered to name a group for", () => {
    // The bug this guards: an extension with no display group belonged to no
    // group at all, so a folder of NEFs could not be filtered by format —
    // while the statistics panel happily listed NEF and offered the click.
    const shoot = [
      entry("DSC_1.NEF", "nef", 1, 1),
      entry("DSC_1.JPG", "jpg", 1, 1),
      entry("DSC_2.NEF", "nef", 1, 1),
    ];
    const raw = withFormatToggled(defaultQuery, "nef");
    expect(applyQuery(shoot, raw, data()).map((e) => e.name)).toEqual([
      "DSC_1.NEF",
      "DSC_2.NEF",
    ]);
  });

  it("withoutFormats drops only the format filter", () => {
    const q = withNameFilter(withFormatToggled(defaultQuery, "png"), "x");
    const stripped = withoutFormats(q);
    expect(stripped.filters).toEqual([{ kind: "name", substring: "x" }]);
  });

  it("value toggles set, switch, and clear their clause", () => {
    const one = withSelectToggled(defaultQuery, "camera", "A");
    expect(one.filters).toEqual([{ kind: "select", field: "camera", value: "A" }]);
    // Another value switches the clause rather than stacking a second one.
    const switched = withSelectToggled(one, "camera", "B");
    expect(switched.filters).toEqual([{ kind: "select", field: "camera", value: "B" }]);
    // The active value clears it.
    expect(withSelectToggled(switched, "camera", "B").filters).toEqual([]);
    // Clauses on different select fields stack.
    const two = withSelectToggled(one, "aspect", "4:3");
    expect(two.filters).toHaveLength(2);
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
    const one = withSelectSet(defaultQuery, "camera", "A");
    expect(withSelectSet(one, "camera", "A").filters).toEqual([
      { kind: "select", field: "camera", value: "A" },
    ]);
    expect(withSelectSet(one, "camera", "B").filters).toEqual([
      { kind: "select", field: "camera", value: "B" },
    ]);
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

describe("formatChoices", () => {
  it("puts what the folder holds first, with counts", () => {
    const choices = formatChoices(ENTRIES);
    expect(choices.slice(0, 3)).toEqual([
      { id: "jpeg", label: "JPEG", count: 2 },
      { id: "png", label: "PNG", count: 1 },
      { id: "webp", label: "WebP", count: 1 },
    ]);
  });

  it("keeps the formats that are absent, at zero", () => {
    // A filter outlives the folder it was set in, so the menu is a list of
    // what you may ask for — not only of what happens to be here.
    const choices = formatChoices(ENTRIES);
    expect(choices.filter((c) => c.count === 0).map((c) => c.id).sort()).toEqual([
      "avif",
      "gif",
    ]);
  });

  it("offers a format the fixed list never heard of", () => {
    const choices = formatChoices([entry("DSC_1.NEF", "nef", 1, 1)]);
    expect(choices[0]).toEqual({ id: "nef", label: "NEF", count: 1 });
  });

  it("orders stably while a scan streams in", () => {
    // Ties break by name rather than by arrival, so rows do not shuffle
    // under the cursor as batches land.
    const a = formatChoices([entry("z.webp", "webp", 1, 1), entry("a.png", "png", 1, 1)]);
    const b = formatChoices([entry("a.png", "png", 1, 1), entry("z.webp", "webp", 1, 1)]);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a[0]?.id).toBe("png");
  });
});
