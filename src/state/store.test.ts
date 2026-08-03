import { beforeAll, describe, expect, it } from "vitest";

import { clearSortsForTest, registerSort } from "../registry/sorts";
import { clearSourcesForTest, registerSource, sourceScope } from "../registry/sources";
import { registerBuiltinSorts } from "../sorts/builtin";
import { defaultQuery } from "./query";
import {
  movedSelection,
  scanBatchArrived,
  sortForScope,
  withQuery,
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

  it("resets the viewport whenever the selection actually moves", () => {
    expect(movedSelection({ selectedIndex: null }, 3, 1)).toMatchObject({
      viewerView: null,
      viewerFitted: true,
    });
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
    };
    expect(
      withQuery(state, { ...defaultQuery, filters: [{ kind: "name", substring: "a." }] })
        .selectedIndex,
    ).toBeNull();
  });
});
