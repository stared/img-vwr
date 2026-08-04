import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import { initialState } from "../state/store";
import { filesBehind, trashPrompt } from "./trash";

const file = (name: string): FileEntry => ({
  path: `/p/${name}`,
  name,
  size: 1,
  modifiedMs: 1,
  formatHint: name.split(".").pop() ?? "",
});

const RAW = file("DSC_1.NEF");
const JPEG = file("DSC_1.JPG");
const OTHER = file("DSC_2.JPG");

/** The grid: every file the camera wrote, listed separately. */
const grid = { ...initialState, entries: [RAW, JPEG, OTHER], galleryLayout: "grid" as const };
/** The darkroom: a raw file and its JPEG are one photograph. */
const darkroom = { ...grid, galleryLayout: "darkroom" as const };

describe("what a delete actually takes", () => {
  it("takes both halves of a photograph that is on screen as one", () => {
    const files = filesBehind(darkroom, [RAW]);
    expect(files.map((f) => f.name).sort()).toEqual(["DSC_1.JPG", "DSC_1.NEF"]);
  });

  it("takes only the file that was picked where both are listed", () => {
    // In the grid the pair is two cells; clicking the raw one means the raw
    // one. Deleting its JPEG too would be deleting something unasked.
    expect(filesBehind(grid, [RAW])).toEqual([RAW]);
  });

  it("names a file once however many of its photographs are selected", () => {
    const files = filesBehind(darkroom, [RAW, JPEG]);
    expect(files).toHaveLength(2);
  });

  it("leaves a photograph with nothing beside it alone", () => {
    expect(filesBehind(darkroom, [OTHER])).toEqual([OTHER]);
  });
});

describe("what the confirmation says", () => {
  it("names the one photograph it is about to take", () => {
    const prompt = trashPrompt([OTHER], [OTHER]);
    expect(prompt).toContain("Move this photograph to the Trash?");
    expect(prompt).toContain("DSC_2.JPG");
  });

  it("says how many files a stacked photograph really is", () => {
    // The count on screen is 1 and the count on disk is 2; saying only the
    // first would be under-reporting what is about to happen.
    const prompt = trashPrompt([RAW], [RAW, JPEG]);
    expect(prompt).toContain(
      "Move this photograph — 2 files, raw and JPEG together — to the Trash?",
    );
  });

  it("counts the rest rather than listing a whole folder", () => {
    const many = Array.from({ length: 30 }, (_, i) => file(`DSC_${i}.JPG`));
    const prompt = trashPrompt(many, many);
    expect(prompt).toContain("these 30 photographs");
    expect(prompt).toContain("and 22 more");
    expect(prompt.split("\n").filter(Boolean)).toHaveLength(10); // question + 8 + "and N more"
  });
});
