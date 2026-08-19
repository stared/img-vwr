import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDevelopStore } from "./develop";
import { restoreSession } from "./session";
import { initialState, useAppStore } from "./store";

/** Must mirror the key session.ts writes. */
const KEY = "imgvwr.session.v1";

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  });
  useAppStore.setState(initialState);
  useDevelopStore.setState({
    folded: {},
    caption: "briefly",
    showDeviation: true,
    gridlines: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreSession", () => {
  it("restores nothing on a fresh machine", () => {
    expect(restoreSession()).toBe(false);
    expect(useAppStore.getState().galleryLayout).toBe("grid");
  });

  it("puts the last sitting back and reopens its folder", () => {
    const opened: Array<[string, boolean]> = [];
    useAppStore.setState({
      openFolder: (path, recursive) => {
        opened.push([path, recursive]);
        return Promise.resolve();
      },
    });
    stored.set(
      KEY,
      JSON.stringify({
        scope: { kind: "folder", path: "/photos", recursive: true },
        galleryLayout: "timeline",
        query: {
          filters: [{ kind: "name", substring: "DSC" }],
          sort: { key: "taken", dir: "desc" },
        },
        stacking: false,
        stackLead: "raw",
        develop: { caption: "off", gridlines: true, folded: { Crop: true } },
      }),
    );
    expect(restoreSession()).toBe(true);
    const s = useAppStore.getState();
    expect(opened).toEqual([["/photos", true]]);
    expect(s.galleryLayout).toBe("timeline");
    expect(s.query).toEqual({
      filters: [{ kind: "name", substring: "DSC" }],
      sort: { key: "taken", dir: "desc" },
    });
    expect(s.stacking).toBe(false);
    expect(s.stackLead).toBe("raw");
    const d = useDevelopStore.getState();
    expect(d.caption).toBe("off");
    expect(d.gridlines).toBe(true);
    expect(d.folded).toEqual({ Crop: true });
  });

  it("degrades a stale or mangled session to defaults, field by field", () => {
    stored.set(
      KEY,
      JSON.stringify({
        scope: { kind: "cloud", bucket: "x" },
        galleryLayout: "cinema",
        query: {
          filters: [{ kind: "select", field: "camera" }, { kind: "name", substring: "a" }],
          sort: { key: 7 },
        },
        stacking: "yes",
        develop: { caption: "loudly" },
      }),
    );
    // An unreadable scope means nothing to reopen, but the readable fields still land.
    expect(restoreSession()).toBe(false);
    const s = useAppStore.getState();
    expect(s.galleryLayout).toBe("grid");
    expect(s.stacking).toBe(true);
    expect(s.query).toEqual({
      filters: [{ kind: "name", substring: "a" }],
      sort: { key: "name", dir: "asc" },
    });
    expect(useDevelopStore.getState().caption).toBe("briefly");
  });

  it("treats unparseable JSON as no session at all", () => {
    stored.set(KEY, "{not json");
    expect(restoreSession()).toBe(false);
    expect(useAppStore.getState().galleryLayout).toBe("grid");
  });
});
