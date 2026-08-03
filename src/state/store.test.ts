import { beforeAll, describe, expect, it } from "vitest";

import { clearSortsForTest, registerSort } from "../registry/sorts";
import { clearSourcesForTest, registerSource, sourceScope } from "../registry/sources";
import { registerBuiltinSorts } from "../sorts/builtin";
import { defaultQuery } from "./query";
import {
  movedSelection,
  scanBatchArrived,
  sortForScope,
  stacksCollapse,
  withQuery,
  withSelection,
  withSelectionHeld,
  type Scope,
} from "./store";

const SOURCE_SCOPE: Scope = { kind: "source", sourceId: "tsrc", arg: "x", label: "x" };
const OTHER_SOURCE_SCOPE: Scope = { kind: "source", sourceId: "plain", arg: "y", label: "y" };
const FOLDER_SCOPE: Scope = { kind: "folder", path: "/p", recursive: false };

beforeAll(() => {
  clearSortsForTest();
  clearSourcesForTest();
  registerBuiltinSorts();
  registerSource({
    id: "tsrc",
    title: "T",
    sidebarTitle: "T",
    glyph: "t",
    placeholder: "",
    label: (arg) => arg,
    fetch: () => Promise.resolve([]),
    sorts: [
      {
        id: "tsrc.rank",
        label: "rank",
        hints: { asc: "as delivered", desc: "reversed" },
        defaultDir: "asc",
        appliesTo: sourceScope("tsrc"),
        reads: "entry",
        missing: "last",
        param: null,
        value: (_entry, ctx) => ctx.sourceIndex,
      },
    ],
    defaultSort: { key: "tsrc.rank", dir: "asc" },
    filters: [],
  });
  registerSort({
    id: "test.similar",
    label: "similar",
    hints: { asc: "least alike", desc: "closest first" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "scores",
    missing: "hide",
    param: {
      segments: () => [{ kind: "text", text: "closest to x" }],
      collectLabel: "closest to…",
      collectHint: "type a phrase",
      isSet: () => true,
      clear: () => {},
    },
    value: (entry, ctx) => ctx.scores[entry.path] ?? null,
  });
  registerSource({
    id: "plain",
    title: "P",
    sidebarTitle: "P",
    glyph: "p",
    placeholder: "",
    label: (arg) => arg,
    fetch: () => Promise.resolve([]),
    sorts: [],
    defaultSort: null,
    filters: [],
  });
});

describe("sortForScope", () => {
  it("a source's declared default sort wins on open", () => {
    expect(sortForScope(SOURCE_SCOPE, { key: "size", dir: "desc" })).toEqual({
      key: "tsrc.rank",
      dir: "asc",
    });
  });

  it("folders keep the current sort when it still applies", () => {
    expect(sortForScope(FOLDER_SCOPE, { key: "size", dir: "desc" })).toEqual({
      key: "size",
      dir: "desc",
    });
  });

  it("a sort scoped to another source falls back to the app default", () => {
    expect(sortForScope(FOLDER_SCOPE, { key: "tsrc.rank", dir: "asc" })).toEqual(
      defaultQuery.sort,
    );
    expect(sortForScope(OTHER_SOURCE_SCOPE, { key: "tsrc.rank", dir: "asc" })).toEqual(
      defaultQuery.sort,
    );
  });

  it("a source without a declared default keeps an applicable sort", () => {
    expect(sortForScope(OTHER_SOURCE_SCOPE, { key: "modified", dir: "desc" })).toEqual({
      key: "modified",
      dir: "desc",
    });
  });

  it("transient sorts (similarity) never survive a scope change", () => {
    expect(sortForScope(FOLDER_SCOPE, { key: "test.similar", dir: "desc" })).toEqual(
      defaultQuery.sort,
    );
  });
});

describe("scanBatchArrived", () => {
  const entry = (path: string) => ({
    path,
    name: path.split("/").pop() ?? path,
    size: 1,
    modifiedMs: 0,
    formatHint: "png",
  });

  it("appends batches without flipping the status", () => {
    const first = scanBatchArrived({ entries: [] }, [entry("/p/a.png")], false);
    expect(first.entries?.map((e) => e.path)).toEqual(["/p/a.png"]);
    expect(first.status).toBeUndefined();

    const second = scanBatchArrived(
      { entries: first.entries ?? [] },
      [entry("/p/b.png")],
      false,
    );
    expect(second.entries?.map((e) => e.path)).toEqual(["/p/a.png", "/p/b.png"]);
  });

  it("the final batch marks the scan loaded", () => {
    const done = scanBatchArrived({ entries: [entry("/p/a.png")] }, [entry("/p/b.png")], true);
    expect(done.entries).toHaveLength(2);
    expect(done.status).toBe("loaded");
  });

  it("an empty final batch still completes the scan", () => {
    const done = scanBatchArrived({ entries: [] }, [], true);
    expect(done.entries).toBeUndefined();
    expect(done.status).toBe("loaded");
  });
});

describe("selection can be empty", () => {
  const entries = [
    { path: "/a.jpg", name: "a.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
    { path: "/b.jpg", name: "b.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
    { path: "/c.jpg", name: "c.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
  ];

  it("enters the collection from whichever end the arrow points from", () => {
    expect(movedSelection({ selectedIndex: null }, 3, 1).selectedIndex).toBe(0);
    expect(movedSelection({ selectedIndex: null }, 3, -1).selectedIndex).toBe(2);
  });

  it("still clamps at the ends once something is selected", () => {
    expect(movedSelection({ selectedIndex: 0 }, 3, -1)).toEqual({});
    expect(movedSelection({ selectedIndex: 2 }, 3, 1)).toEqual({});
    expect(movedSelection({ selectedIndex: 1 }, 3, 1).selectedIndex).toBe(2);
  });

  it("does nothing in an empty collection", () => {
    expect(movedSelection({ selectedIndex: null }, 0, 1)).toEqual({});
  });

  it("leaves the viewport alone, so a zoomed-in comparison survives the move", () => {
    // Fit is a state the viewport tracks, not something re-imposed on every
    // step: a view sitting at fit refits itself when the next image loads,
    // and one that has been zoomed in stays where the user put it.
    expect(movedSelection({ selectedIndex: null }, 3, 1)).toEqual({ selectedIndex: 0 });
    expect(withSelection(2)).toEqual({ selectedIndex: 2 });
  });

  it("clears rather than reassigns when the selected image is filtered out", () => {
    const state = {
      entries,
      query: defaultQuery,
      selectedIndex: 1,
      meta: {},
      similarity: null,
      labels: {},
      stacking: false,
      preferredMember: {},
      viewMode: "gallery" as const,
      galleryLayout: "grid" as const,
    };
    // A name filter that keeps only "a" drops the selected "b".
    const dropped = withQuery(state, {
      ...defaultQuery,
      filters: [{ kind: "name", substring: "a." }],
    });
    expect(dropped.selectedIndex).toBeNull();
  });

  it("keeps the same image selected when it survives the new query", () => {
    const state = {
      entries,
      query: defaultQuery,
      selectedIndex: 2,
      meta: {},
      similarity: null,
      labels: {},
      stacking: false,
      preferredMember: {},
      viewMode: "gallery" as const,
      galleryLayout: "grid" as const,
    };
    const kept = withQuery(state, {
      ...defaultQuery,
      filters: [{ kind: "name", substring: "c." }],
    });
    expect(kept.selectedIndex).toBe(0);
  });

  it("stays empty across a query change", () => {
    const state = {
      entries,
      query: defaultQuery,
      selectedIndex: null,
      meta: {},
      similarity: null,
      labels: {},
      stacking: false,
      preferredMember: {},
      viewMode: "gallery" as const,
      galleryLayout: "grid" as const,
    };
    expect(
      withQuery(state, { ...defaultQuery, filters: [{ kind: "name", substring: "a." }] })
        .selectedIndex,
    ).toBeNull();
  });
});

describe("stacking is a darkroom rule", () => {
  const state = (
    patch: Partial<{
      stacking: boolean;
      viewMode: "gallery" | "viewer";
      galleryLayout: "grid" | "timeline" | "map" | "darkroom";
    }>,
  ) => ({
    stacking: true,
    viewMode: "gallery" as const,
    galleryLayout: "grid" as const,
    ...patch,
  });

  it("collapses pairs where one photograph is on screen at a time", () => {
    expect(stacksCollapse(state({ galleryLayout: "darkroom" }))).toBe(true);
    expect(stacksCollapse(state({ viewMode: "viewer" }))).toBe(true);
  });

  it("leaves the grid, the timeline and the map listing every file", () => {
    expect(stacksCollapse(state({}))).toBe(false);
    expect(stacksCollapse(state({ galleryLayout: "timeline" }))).toBe(false);
    expect(stacksCollapse(state({ galleryLayout: "map" }))).toBe(false);
  });

  it("is still a switch — off means off wherever you are", () => {
    expect(stacksCollapse(state({ stacking: false, galleryLayout: "darkroom" }))).toBe(false);
    expect(stacksCollapse(state({ stacking: false, viewMode: "viewer" }))).toBe(false);
  });
});

describe("a selection follows its photograph across a collapse", () => {
  const pair = [
    { path: "/p/DSC_1.NEF", name: "DSC_1.NEF", size: 1, modifiedMs: 1, formatHint: "nef" },
    { path: "/p/DSC_1.JPG", name: "DSC_1.JPG", size: 1, modifiedMs: 1, formatHint: "jpg" },
    { path: "/p/DSC_2.JPG", name: "DSC_2.JPG", size: 1, modifiedMs: 1, formatHint: "jpg" },
  ];
  const base = {
    entries: pair,
    query: defaultQuery,
    meta: {},
    similarity: null,
    labels: {},
    stacking: true,
    preferredMember: {},
    viewMode: "gallery" as const,
    galleryLayout: "grid" as const,
  };

  /* Sorted by name, the grid lists DSC_1.JPG, DSC_1.NEF, DSC_2.JPG; the
   * darkroom collapses the first two into one photograph led by the raw
   * file, and lists DSC_1, DSC_2. */

  it("lands on the stack's lead when the selected file is the one collapsed away", () => {
    // Looking at DSC_1.JPG in the grid, then opening the darkroom: that file
    // is not in the list any more, but its photograph is — under the raw
    // file. Emptying the selection there would be losing the user's place.
    const held = withSelectionHeld({ ...base, selectedIndex: 0 }, { galleryLayout: "darkroom" });
    expect(held.selectedIndex).toBe(0);
  });

  it("keeps the file itself when it is still listed", () => {
    // DSC_2.JPG survives the collapse; it just sits one place earlier.
    const held = withSelectionHeld({ ...base, selectedIndex: 2 }, { galleryLayout: "darkroom" });
    expect(held.selectedIndex).toBe(1);
  });

  it("expands back onto the file that was showing", () => {
    const darkroom = { ...base, galleryLayout: "darkroom" as const, selectedIndex: 0 };
    const held = withSelectionHeld(darkroom, { galleryLayout: "grid" });
    // The raw file, which is where the JPEG beside it now sits at index 0.
    expect(held.selectedIndex).toBe(1);
  });
});
