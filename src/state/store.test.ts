import { beforeAll, describe, expect, it } from "vitest";

import { clearSortsForTest } from "../registry/sorts";
import { clearSourcesForTest, registerSource } from "../registry/sources";
import { registerBuiltinSorts } from "../sorts/builtin";
import { defaultQuery } from "./query";
import { sortForScope, type Scope } from "./store";

const SOURCE_SCOPE: Scope = { kind: "source", sourceId: "tsrc", arg: "x", label: "x" };
const OTHER_SOURCE_SCOPE: Scope = { kind: "source", sourceId: "plain", arg: "y", label: "y" };
const FOLDER_SCOPE: Scope = { kind: "folder", path: "/p" };

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
        defaultDir: "asc",
        value: (_entry, ctx) => ctx.sourceIndex,
      },
    ],
    defaultSort: { key: "tsrc.rank", dir: "asc" },
  });
  registerSource({
    id: "plain",
    title: "P",
    sidebarTitle: "P",
    glyph: "p",
    placeholder: "",
    label: (arg) => arg,
    fetch: () => Promise.resolve([]),
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
});
