import { beforeAll, describe, expect, it } from "vitest";
import { create } from "zustand";

import type { FileEntry } from "../ipc";
import { channelsRead, defaultQuery, type Query } from "../state/query";
import { initialState, visibleOf } from "../state/store";
import { photoData, storeChannel, type Channel } from "./channels";
import { registerSort } from "./sorts";

const useScores = create<{ scores: Record<string, number> }>()(() => ({ scores: {} }));
const SCORE = storeChannel(useScores, (s) => s.scores, null as number | null);
const OTHER: Channel<string> = { missing: "", read: () => ({}), subscribe: () => () => {} };

const entry = (name: string): FileEntry => ({
  path: `/p/${name}`,
  name,
  formatHint: "jpg",
  size: 1,
  modifiedMs: 0,
});
const ENTRIES = [entry("a.jpg"), entry("b.jpg"), entry("c.jpg")];
const byScore: Query = { ...defaultQuery, sort: { key: "test.score", dir: "desc" } };
const state = { ...initialState, entries: ENTRIES };

beforeAll(() => {
  registerSort({
    id: "test.score",
    label: "score",
    hints: { asc: "lowest", desc: "highest" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: [SCORE],
    missing: "last",
    param: null,
    value: (_entry, data) => data.get(SCORE),
  });
});

describe("photoData", () => {
  it("reads a photo's value, and the channel's missing value for anything else", () => {
    const data = photoData(new Map([[SCORE as Channel<unknown>, { "/p/a.jpg": 0.5 }]]), "/p/a.jpg");
    expect(data.get(SCORE)).toBe(0.5);
    expect(photoData(new Map(), "/p/a.jpg").get(SCORE)).toBeNull();
    expect(data.get(OTHER)).toBe("");
  });
});

describe("channelsRead", () => {
  it("names exactly the channels the active sort and clauses read", () => {
    expect(channelsRead(defaultQuery)).toEqual([]);
    expect(channelsRead(byScore)).toEqual([SCORE]);
  });
});

describe("visibleOf", () => {
  it("re-derives when a channel the query reads changes, and only then", () => {
    useScores.setState({ scores: { "/p/c.jpg": 0.9, "/p/a.jpg": 0.1 } });
    const first = visibleOf(state, byScore);
    expect(first.map((e) => e.name)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
    expect(visibleOf(state, byScore)).toBe(first);

    useScores.setState({ scores: { "/p/b.jpg": 1 } });
    expect(visibleOf(state, byScore)[0]?.name).toBe("b.jpg");

    // A name sort never looks at scores, so new scores leave its list untouched.
    const byName = visibleOf(state, defaultQuery);
    useScores.setState({ scores: {} });
    expect(visibleOf(state, defaultQuery)).toBe(byName);
  });
});
