import { beforeAll, describe, expect, it } from "vitest";

import { clearSortsForTest, registerSort } from "../registry/sorts";
import { clearSourcesForTest, registerSource, sourceScope } from "../registry/sources";
import { registerBuiltinSorts } from "../sorts/builtin";
import { defaultQuery } from "./query";
import { folderRescanned } from "./collection";
import {
  movedSelection,
  scanBatchArrived,
  selectMode,
  sortForScope,
  stacksCollapse,
  withDeleted,
  withQuery,
  withSelection,
  withSelectionAt,
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

const entries = [
  { path: "/a.jpg", name: "a.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
  { path: "/b.jpg", name: "b.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
  { path: "/c.jpg", name: "c.jpg", size: 1, modifiedMs: 1, formatHint: "jpg" },
];

/** A gallery of a.jpg, b.jpg, c.jpg with the given photographs selected. */
function showing(selected: number[], anchor: number | null = null) {
  const chosen = selected.map((i) => entries[i]?.path ?? "");
  return {
    entries,
    query: defaultQuery,
    selectedIndex: selected.length === 0 ? null : (selected[selected.length - 1] ?? null),
    selection: chosen,
    selectionAnchor: anchor === null ? (chosen[0] ?? null) : (entries[anchor]?.path ?? null),
    meta: {},
    similarity: null,
    labels: {},
    peopleByPath: {},
    thumbs: {},
    thumbErrors: {},
    stacking: false,
    stackLead: "jpg" as const,
    preferredMember: {},
    viewMode: "gallery" as const,
    galleryLayout: "grid" as const,
  };
}

describe("selection can be empty", () => {
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
    expect(withSelection(showing([]), 2)).toEqual({
      selectedIndex: 2,
      selection: ["/c.jpg"],
      selectionAnchor: "/c.jpg",
    });
  });

  it("clears rather than reassigns when the selected image is filtered out", () => {
    // A name filter that keeps only "a" drops the selected "b".
    const dropped = withQuery(showing([1]), {
      ...defaultQuery,
      filters: [{ kind: "name", substring: "a." }],
    });
    expect(dropped.selectedIndex).toBeNull();
    expect(dropped.selection).toEqual([]);
  });

  it("keeps the same image selected when it survives the new query", () => {
    const kept = withQuery(showing([2]), {
      ...defaultQuery,
      filters: [{ kind: "name", substring: "c." }],
    });
    expect(kept.selectedIndex).toBe(0);
    expect(kept.selection).toEqual(["/c.jpg"]);
  });

  it("stays empty across a query change", () => {
    expect(
      withQuery(showing([]), { ...defaultQuery, filters: [{ kind: "name", substring: "a." }] })
        .selectedIndex,
    ).toBeNull();
  });
});

describe("several photographs at once", () => {
  it("reads the modifiers the platform uses for adding and for reaching", () => {
    const plain = { metaKey: false, ctrlKey: false, shiftKey: false };
    expect(selectMode(plain)).toBe("replace");
    expect(selectMode({ ...plain, metaKey: true })).toBe("extend");
    expect(selectMode({ ...plain, ctrlKey: true })).toBe("extend");
    expect(selectMode({ ...plain, shiftKey: true })).toBe("range");
    // Both held: reaching wins, as it does in every file manager.
    expect(selectMode({ ...plain, metaKey: true, shiftKey: true })).toBe("range");
  });

  it("adds one and takes one back out", () => {
    const added = withSelectionAt(showing([0]), 2, "extend");
    expect(added.selection).toEqual(["/a.jpg", "/c.jpg"]);
    expect(added.selectedIndex).toBe(2);

    const removed = withSelectionAt(showing([0, 2]), 2, "extend");
    expect(removed.selection).toEqual(["/a.jpg"]);
    // The lead was the one taken out, so it moves to what is left.
    expect(removed.selectedIndex).toBe(0);
  });

  it("selects nothing at all once the last one is taken out", () => {
    expect(withSelectionAt(showing([1]), 1, "extend")).toEqual({
      selectedIndex: null,
      selection: [],
      selectionAnchor: null,
    });
  });

  it("reaches from the anchor, and keeps reaching from it", () => {
    const reached = withSelectionAt(showing([1]), 2, "range");
    expect(reached.selection).toEqual(["/b.jpg", "/c.jpg"]);
    expect(reached.selectionAnchor).toBe("/b.jpg");

    // Reaching the other way corrects the range rather than adding to it:
    // b is still the anchor, so this is b..a, not a..c.
    const corrected = withSelectionAt({ ...showing([1, 2], 1), selectedIndex: 2 }, 0, "range");
    expect(corrected.selection).toEqual(["/a.jpg", "/b.jpg"]);
  });

  it("keeps every survivor of a query change, in the order they now appear", () => {
    const state = { ...showing([0, 2]), selectedIndex: 0 };
    const kept = withQuery(state, { ...defaultQuery, sort: { key: "name", dir: "desc" } });
    expect(kept.selection).toEqual(["/c.jpg", "/a.jpg"]);
    expect(kept.selectedIndex).toBe(2);
  });

  it("moves the lead onto another chosen photograph when the lead is filtered away", () => {
    // Selecting a and c, leading on c, then filtering to just a: c is gone,
    // but a is still one the user picked, so it leads rather than the whole
    // selection being dropped for one missing member.
    const state = { ...showing([0, 2]), selectedIndex: 2 };
    const kept = withQuery(state, {
      ...defaultQuery,
      filters: [{ kind: "name", substring: "a." }],
    });
    expect(kept.selectedIndex).toBe(0);
    expect(kept.selection).toEqual(["/a.jpg"]);
  });
});

describe("deleting takes photographs out of the collection", () => {
  it("lands on what took the deleted photograph's place, ready for the next one", () => {
    const after = withDeleted({ ...showing([1]), thumbs: { "/b.jpg": "/cache/b" } }, ["/b.jpg"]);
    expect(after.entries?.map((e) => e.name)).toEqual(["a.jpg", "c.jpg"]);
    expect(after.selectedIndex).toBe(1);
    expect(after.selection).toEqual(["/c.jpg"]);
    // The cached pixels of a file that is gone are gone with it.
    expect(after.thumbs).toEqual({});
  });

  it("falls back to the end when the last photograph was the one deleted", () => {
    const after = withDeleted(showing([2]), ["/c.jpg"]);
    expect(after.selectedIndex).toBe(1);
    expect(after.selection).toEqual(["/b.jpg"]);
  });

  it("selects nothing when the whole collection went", () => {
    const after = withDeleted(showing([0, 1, 2]), ["/a.jpg", "/b.jpg", "/c.jpg"]);
    expect(after.entries).toEqual([]);
    expect(after.selectedIndex).toBeNull();
    expect(after.selection).toEqual([]);
  });

  it("leaves the lead alone when something else was deleted", () => {
    const after = withDeleted(showing([2]), ["/a.jpg"]);
    expect(after.selectedIndex).toBe(1);
    expect(after.selection).toEqual(["/c.jpg"]);
  });

  it("does nothing at all when none of the paths were in the collection", () => {
    expect(withDeleted(showing([1]), ["/elsewhere.jpg"])).toEqual({});
  });
});

describe("stacking is a darkroom rule", () => {
  const state = (
    patch: Partial<{
      stacking: boolean;
      viewMode: "gallery" | "viewer";
      galleryLayout: "grid" | "timeline" | "map" | "darkroom" | "scenes";
    }>,
  ) => ({
    stacking: true,
    viewMode: "gallery" as const,
    galleryLayout: "grid" as const,
    ...patch,
  });

  it("collapses pairs where one photograph is on screen at a time", () => {
    expect(stacksCollapse(state({ galleryLayout: "darkroom" }))).toBe(true);
    expect(stacksCollapse(state({ galleryLayout: "scenes" }))).toBe(true);
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
    peopleByPath: {},
    stacking: true,
    // Raw-led here so the collapse genuinely swaps which file is showing —
    // the harder case for holding the selection.
    stackLead: "raw" as const,
    preferredMember: {},
    viewMode: "gallery" as const,
    galleryLayout: "grid" as const,
    selection: [] as string[],
    selectionAnchor: null as string | null,
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

describe("folderRescanned", () => {
  const file = (name: string, size = 1, modifiedMs = 1) => ({
    path: `/p/${name}`,
    name,
    size,
    modifiedMs,
    formatHint: name.split(".").pop() ?? "",
  });
  const state = (entries: ReturnType<typeof file>[], thumbs = {}, thumbErrors = {}) => ({
    entries,
    thumbs: thumbs as Record<string, string>,
    thumbErrors: thumbErrors as Record<string, string>,
  });

  it("returns nothing at all when the folder is unchanged", () => {
    // A watched folder must cost nothing while it is quiet — an empty patch
    // means no consumer re-renders and no memo is thrown away.
    const entries = [file("a.jpg"), file("b.jpg")];
    expect(folderRescanned(state(entries), [file("a.jpg"), file("b.jpg")])).toEqual({});
  });

  it("appends what appeared, keeping the files already on screen identical", () => {
    const a = file("a.jpg");
    const patch = folderRescanned(state([a]), [file("a.jpg"), file("new.nef")]);
    expect(patch.entries?.map((e) => e.name)).toEqual(["a.jpg", "new.nef"]);
    // Identity, not just equality: the cell showing it must not re-render.
    expect(patch.entries?.[0]).toBe(a);
  });

  it("appends rather than sorting in, so index-based readers stay valid", () => {
    const patch = folderRescanned(state([file("z.jpg")]), [file("a.jpg"), file("z.jpg")]);
    expect(patch.entries?.map((e) => e.name)).toEqual(["z.jpg", "a.jpg"]);
  });

  it("drops what vanished, along with its cached thumbnail", () => {
    const patch = folderRescanned(
      state([file("a.jpg"), file("gone.jpg")], { "/p/a.jpg": "ta", "/p/gone.jpg": "tg" }),
      [file("a.jpg")],
    );
    expect(patch.entries?.map((e) => e.name)).toEqual(["a.jpg"]);
    expect(patch.thumbs).toEqual({ "/p/a.jpg": "ta" });
  });

  it("re-fetches a file that changed on disk", () => {
    // The case that matters: the previous scan caught this one mid-copy, so
    // its thumbnail is a picture of a truncated file and its recorded error
    // is about a file that no longer exists in that state.
    const patch = folderRescanned(
      state([file("half.nef", 1000)], { "/p/half.nef": "t" }, { "/p/half.nef": "decode failed" }),
      [file("half.nef", 24_000_000, 99)],
    );
    expect(patch.entries?.[0]?.size).toBe(24_000_000);
    expect(patch.thumbs).toEqual({});
    expect(patch.thumbErrors).toEqual({});
  });

  it("leaves an untouched file's thumbnail alone", () => {
    const patch = folderRescanned(
      state([file("a.jpg")], { "/p/a.jpg": "ta" }),
      [file("a.jpg"), file("b.jpg")],
    );
    expect(patch.thumbs).toEqual({ "/p/a.jpg": "ta" });
  });
});
