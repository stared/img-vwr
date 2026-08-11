import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import {
  candidatesOf,
  DEFAULT_OPTIONS,
  planAll,
  planFor,
  sameSize,
  summaryOf,
  type Candidate,
} from "./export";

function file(path: string): FileEntry {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    formatHint: dot < 0 ? "" : name.slice(dot + 1).toLowerCase(),
    size: 1,
    modifiedMs: 0,
  };
}

/** Index into a fixture, insisting it is there — a missing one is a broken
 * test, not a case to handle. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

/** A shoot the way a camera writes one: a raw and a JPEG per frame. */
const PAIRS = ["/shoot/DSC_0001", "/shoot/DSC_0002", "/shoot/DSC_0003"];
const SCAN = PAIRS.flatMap((stem) => [file(`${stem}.NEF`), file(`${stem}.JPG`)]);

function candidate(stem: string, edited: boolean): Candidate {
  const stack = SCAN.filter((f) => f.path.startsWith(stem));
  return { entry: need(stack.find((f) => f.formatHint === "nef"), "a raw"), stack, edited };
}

describe("planFor", () => {
  it("copies the camera's JPG for a raw nobody edited", () => {
    const planned = planFor(candidate("/shoot/DSC_0001", false), DEFAULT_OPTIONS);
    expect(planned.reason).toBe("camera-jpg");
    expect(planned.job).toEqual({ kind: "copy", path: "/shoot/DSC_0001.JPG" });
  });

  it("develops a raw that has an edit, whatever the policy says", () => {
    const planned = planFor(candidate("/shoot/DSC_0001", true), DEFAULT_OPTIONS);
    expect(planned.reason).toBe("edited");
    expect(planned.job.kind).toBe("render");
  });

  it("develops an untouched raw with no JPG beside it", () => {
    const lone = file("/shoot/DSC_0009.NEF");
    const planned = planFor({ entry: lone, stack: [lone], edited: false }, DEFAULT_OPTIONS);
    expect(planned.reason).toBe("no-jpg");
    expect(planned.job).toEqual({
      kind: "render",
      path: "/shoot/DSC_0009.NEF",
      exif: { kind: "none" },
    });
  });

  it("gives a developed frame the metadata of the JPG shot beside it", () => {
    // Rendered pixels have no EXIF of their own; the frame next to them on
    // the card knows the date, the lens and the exposure.
    const planned = planFor(candidate("/shoot/DSC_0002", true), DEFAULT_OPTIONS);
    expect(planned.job).toEqual({
      kind: "render",
      path: "/shoot/DSC_0002.NEF",
      exif: { kind: "file", path: "/shoot/DSC_0002.JPG" },
    });
  });

  it("develops everything when asked to", () => {
    const planned = planFor(candidate("/shoot/DSC_0003", false), {
      ...DEFAULT_OPTIONS,
      unedited: "render",
    });
    expect(planned.reason).toBe("always-render");
    expect(planned.job.kind).toBe("render");
  });

  it("develops everything for a PNG export, because a JPG is not a PNG", () => {
    const planned = planFor(candidate("/shoot/DSC_0003", false), {
      ...DEFAULT_OPTIONS,
      format: { kind: "png" },
    });
    expect(planned.job.kind).toBe("render");
  });

  it("copies an untouched JPEG rather than encoding it again", () => {
    // Re-encoding pixels nobody changed can only lose, and takes longer.
    const jpg = need(SCAN.find((f) => f.path === "/shoot/DSC_0001.JPG"), "the JPG");
    const planned = planFor(
      { entry: jpg, stack: [jpg], edited: false },
      DEFAULT_OPTIONS,
    );
    expect(planned.job).toEqual({ kind: "copy", path: "/shoot/DSC_0001.JPG" });
  });
});

describe("candidatesOf", () => {
  it("finds the whole stack behind each chosen photograph", () => {
    const chosen = [need(SCAN[0], "the first file")];
    const [candidate] = candidatesOf(chosen, SCAN, new Set());
    expect(candidate?.stack.map((f) => f.name).sort()).toEqual([
      "DSC_0001.JPG",
      "DSC_0001.NEF",
    ]);
  });

  it("counts a photograph as edited when any of its files is", () => {
    // The edit was made on whichever half of the pair was on screen; the
    // frame is one photograph either way.
    const chosen = [need(SCAN[1], "the JPG")];
    const [candidate] = candidatesOf(chosen, SCAN, new Set(["/shoot/DSC_0001.NEF"]));
    expect(candidate?.edited).toBe(true);
  });
});

describe("summaryOf", () => {
  it("says how the export splits before anything is written", () => {
    const planned = planAll(
      [
        candidate("/shoot/DSC_0001", true),
        candidate("/shoot/DSC_0002", false),
        candidate("/shoot/DSC_0003", false),
      ],
      DEFAULT_OPTIONS,
    );
    expect(summaryOf(planned)).toBe(
      "3 photographs: 1 developed, 2 copied from the camera's JPG",
    );
  });

  it("does not split a total that has only one side", () => {
    const all = planAll([candidate("/shoot/DSC_0001", true)], DEFAULT_OPTIONS);
    expect(summaryOf(all)).toBe("1 photograph, all developed");
    const none = planAll([candidate("/shoot/DSC_0001", false)], DEFAULT_OPTIONS);
    expect(summaryOf(none)).toBe("1 photograph, all copied from the camera's JPG");
    expect(summaryOf([])).toBe("nothing selected");
  });
});

describe("sameSize", () => {
  it("tells the sizes apart so a row can say which one is on", () => {
    expect(sameSize({ kind: "full" }, { kind: "full" })).toBe(true);
    expect(sameSize({ kind: "full" }, { kind: "longest", pixels: 2048 })).toBe(false);
    expect(
      sameSize({ kind: "longest", pixels: 2048 }, { kind: "longest", pixels: 2048 }),
    ).toBe(true);
    expect(
      sameSize({ kind: "longest", pixels: 2048 }, { kind: "longest", pixels: 1024 }),
    ).toBe(false);
  });
});

// Kept honest: the summary is derived from the jobs, never from the options,
// so it cannot claim a split the export will not carry out.
describe("the summary and the jobs agree", () => {
  it("counts exactly the copies that will happen", () => {
    const planned = planAll(
      PAIRS.map((stem, at) => candidate(stem, at === 0)),
      DEFAULT_OPTIONS,
    );
    const copies = planned.filter((p) => p.job.kind === "copy").length;
    expect(summaryOf(planned)).toContain(`${copies} copied`);
  });
});
