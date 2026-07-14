import { beforeAll, describe, expect, it } from "vitest";

import { clearSortsForTest, registerSort } from "../registry/sorts";
import { clearSourcesForTest, registerSource, sourceScope } from "../registry/sources";
import { registerBuiltinSorts } from "../sorts/builtin";
import { defaultQuery } from "./query";
import { scanBatchArrived, sortForScope, type Scope } from "./store";

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
