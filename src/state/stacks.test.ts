import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import {
  collapseStacks,
  isRawEntry,
  leadOf,
  siblingsOf,
  stackCaption,
  stackFormats,
  stackKeyOf,
} from "./stacks";

function file(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name,
    size: 1,
    modifiedMs: 0,
    formatHint: name.slice(name.lastIndexOf(".") + 1).toLowerCase(),
  };
}

const shoot = [
  file("/p/DSC_0001.JPG"),
  file("/p/DSC_0001.NEF"),
  file("/p/DSC_0002.JPG"),
  file("/p/DSC_0003.NEF"),
];

describe("stackKeyOf", () => {
  it("is the folder plus the name before the extension", () => {
    expect(stackKeyOf(file("/p/DSC_0001.NEF"))).toBe(stackKeyOf(file("/p/DSC_0001.JPG")));
  });

  it("keeps two shoots apart when a camera restarts its numbering", () => {
    // The failure this prevents is merging unrelated photographs, which is
    // worse than not stacking at all.
    expect(stackKeyOf(file("/monday/DSC_0001.NEF"))).not.toBe(
      stackKeyOf(file("/tuesday/DSC_0001.NEF")),
    );
  });

  it("copes with dots in the name and with no extension at all", () => {
    expect(stackKeyOf(file("/p/2026.08.02 walk.NEF"))).toBe("/p/2026.08.02 walk");
    expect(stackKeyOf(file("/p/scan"))).toBe("/p/scan");
  });
});

describe("collapseStacks", () => {
  it("shows the JPG of a pair by default and leaves lone files alone", () => {
    const collapsed = collapseStacks(shoot, {}, "jpg");
    expect(collapsed.map((e) => e.name)).toEqual([
      "DSC_0001.JPG",
      "DSC_0002.JPG",
      "DSC_0003.NEF",
    ]);
  });

  it("shows the raw file when the lead asks for it", () => {
    const collapsed = collapseStacks(shoot, {}, "raw");
    expect(collapsed.map((e) => e.name)).toEqual([
      "DSC_0001.NEF",
      "DSC_0002.JPG",
      "DSC_0003.NEF",
    ]);
  });

  it("keeps each stack where its first member sat, so the sort still holds", () => {
    // Reverse-name order: the pair must stay at the front, not jump to
    // wherever the raw file happened to be.
    const reversed = [...shoot].reverse();
    const collapsed = collapseStacks(reversed, {}, "raw");
    expect(collapsed.map((e) => e.name)).toEqual([
      "DSC_0003.NEF",
      "DSC_0002.JPG",
      "DSC_0001.NEF",
    ]);
  });

  it("shows the member that was picked instead, whatever the lead says", () => {
    const picked = collapseStacks(shoot, { "/p/DSC_0001": "/p/DSC_0001.NEF" }, "jpg");
    expect(picked.map((e) => e.name)).toEqual(["DSC_0001.NEF", "DSC_0002.JPG", "DSC_0003.NEF"]);
  });

  it("ignores a preference for a file the query has filtered away", () => {
    // Only the raw file survives the filter; the stored preference names the
    // JPEG, which is no longer there to show.
    const onlyRaw = shoot.filter((e) => e.formatHint === "nef");
    const collapsed = collapseStacks(onlyRaw, { "/p/DSC_0001": "/p/DSC_0001.JPG" }, "jpg");
    expect(collapsed.map((e) => e.name)).toEqual(["DSC_0001.NEF", "DSC_0003.NEF"]);
  });

  it("changes nothing when a folder holds no pairs", () => {
    const singles = [file("/p/a.JPG"), file("/p/b.JPG")];
    expect(collapseStacks(singles, {}, "jpg")).toEqual(singles);
  });
});

describe("leadOf", () => {
  it("gives each default its member: the JPG to send, the raw to edit", () => {
    const pair = [file("/p/x.JPG"), file("/p/x.NEF")];
    expect(leadOf(pair, undefined, "jpg")?.name).toBe("x.JPG");
    expect(leadOf(pair, undefined, "raw")?.name).toBe("x.NEF");
  });

  it("falls back to the first member when nothing matches the lead", () => {
    const finished = [file("/p/x.JPG"), file("/p/x.PNG")];
    expect(leadOf(finished, undefined, "raw")?.name).toBe("x.JPG");
    const negatives = [file("/p/x.NEF"), file("/p/x.DNG")];
    expect(leadOf(negatives, undefined, "jpg")?.name).toBe("x.NEF");
  });

  it("has no lead for an empty stack", () => {
    expect(leadOf([], undefined, "jpg")).toBeNull();
  });
});

describe("isRawEntry", () => {
  it("knows a negative from a finished picture", () => {
    expect(isRawEntry(file("/p/a.NEF"))).toBe(true);
    expect(isRawEntry(file("/p/a.cr3"))).toBe(true);
    expect(isRawEntry(file("/p/a.JPG"))).toBe(false);
    expect(isRawEntry(file("/p/a.png"))).toBe(false);
  });
});

describe("siblingsOf and stackCaption", () => {
  it("finds the other files that are the same photograph", () => {
    expect(siblingsOf(shoot, file("/p/DSC_0001.NEF")).map((e) => e.name)).toEqual([
      "DSC_0001.JPG",
    ]);
    expect(siblingsOf(shoot, file("/p/DSC_0002.JPG"))).toEqual([]);
  });

  it("says in words what else is in the stack, and nothing when it is alone", () => {
    expect(stackCaption(file("/p/DSC_0001.NEF"), [file("/p/DSC_0001.JPG")])).toBe(
      "DSC_0001.NEF +JPG",
    );
    expect(stackCaption(file("/p/DSC_0002.JPG"), [])).toBe("DSC_0002.JPG");
  });

  it("badges a pile by its formats, the shown one first", () => {
    expect(stackFormats(file("/p/DSC_0001.JPG"), [file("/p/DSC_0001.NEF")])).toBe("JPG+NEF");
    expect(stackFormats(file("/p/DSC_0001.NEF"), [file("/p/DSC_0001.JPG")])).toBe("NEF+JPG");
    expect(stackFormats(file("/p/DSC_0002.JPG"), [])).toBe("JPG");
  });
});
