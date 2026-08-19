import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import { candidatesOf } from "../state/export";
import { copyPlan } from "./copy";

const file = (name: string): FileEntry => ({
  path: `/p/${name}`,
  name,
  size: 1,
  modifiedMs: 1,
  formatHint: name.split(".").pop() ?? "",
});

const RAW = file("DSC_1.NEF");
const JPEG = file("DSC_1.JPG");
const PLAIN = file("DSC_2.JPG");

describe("what a copy actually hands over", () => {
  it("hands over the file itself when nothing was edited", () => {
    const plan = copyPlan(candidatesOf([PLAIN], [PLAIN], new Set()));
    expect(plan).toEqual([{ kind: "file", path: PLAIN.path }]);
  });

  it("renders a cropped photograph rather than copying the uncropped file", () => {
    const plan = copyPlan(candidatesOf([PLAIN], [PLAIN], new Set([PLAIN.path])));
    expect(plan).toEqual([
      { kind: "render", path: PLAIN.path, exif: { kind: "file", path: PLAIN.path } },
    ]);
  });

  it("counts an edit made on the raw for the JPEG standing in front of it", () => {
    const plan = copyPlan(candidatesOf([JPEG], [RAW, JPEG], new Set([RAW.path])));
    expect(plan[0]?.kind).toBe("render");
  });

  it("gives a rendered raw its sibling JPEG's metadata", () => {
    const plan = copyPlan(candidatesOf([RAW], [RAW, JPEG], new Set([RAW.path])));
    expect(plan).toEqual([
      { kind: "render", path: RAW.path, exif: { kind: "file", path: JPEG.path } },
    ]);
  });

  it("renders an HDR face even with no stored edit", () => {
    const plan = copyPlan(candidatesOf([PLAIN], [PLAIN], new Set(), new Set([PLAIN.path])));
    expect(plan[0]?.kind).toBe("render");
  });

  it("mixes untouched files and renders in selection order", () => {
    const plan = copyPlan(
      candidatesOf([PLAIN, JPEG], [RAW, JPEG, PLAIN], new Set([JPEG.path])),
    );
    expect(plan.map((s) => s.kind)).toEqual(["file", "render"]);
  });
});
