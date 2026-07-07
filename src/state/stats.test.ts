import { describe, expect, it } from "vitest";

import type { FileEntry } from "../ipc";
import type { ImageMeta } from "../ipc/bindings";
import {
  aspectBuckets,
  cameraCounts,
  edgeBuckets,
  effectiveDims,
  formatBytes,
  formatCounts,
  orientationSplit,
  parseExifDate,
  sizeBuckets,
  timeBuckets,
} from "./stats";

function entry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/x/a.jpg",
    name: "a.jpg",
    size: 1000,
    modifiedMs: 0,
    formatHint: "jpg",
    ...overrides,
  };
}

function meta(overrides: Partial<ImageMeta>): ImageMeta {
  return {
    width: 100,
    height: 100,
    format: "jpg",
    fileSize: 1000,
    modifiedMs: 0,
    exif: null,
    ...overrides,
  };
}

describe("parseExifDate", () => {
  it("parses the EXIF colon format", () => {
    const expected = new Date(2023, 4, 12, 14, 33, 21).getTime();
    expect(parseExifDate("2023:05:12 14:33:21")).toBe(expected);
  });

  it("parses dash separators too", () => {
    const expected = new Date(2023, 4, 12, 14, 33, 21).getTime();
    expect(parseExifDate("2023-05-12 14:33:21")).toBe(expected);
  });

  it("rejects garbage and zeroed dates", () => {
    expect(parseExifDate("not a date")).toBeNull();
    expect(parseExifDate("")).toBeNull();
    expect(parseExifDate("0000:00:00 00:00:00")).toBeNull();
  });
});

describe("effectiveDims", () => {
  it("passes dimensions through for normal orientation", () => {
    expect(effectiveDims(meta({ width: 300, height: 200 }))).toEqual({ width: 300, height: 200 });
  });

  it("swaps width and height for rotated orientations (5-8)", () => {
    const rotated = meta({
      width: 300,
      height: 200,
      exif: { orientation: 6, dateTime: null, camera: null },
    });
    expect(effectiveDims(rotated)).toEqual({ width: 200, height: 300 });
  });

  it("returns null when dimensions are unknown", () => {
    expect(effectiveDims(meta({ width: null, height: null }))).toBeNull();
  });
});

describe("formatCounts", () => {
  it("folds jpg and jpeg into one group and sorts by count", () => {
    const entries = [
      entry({ formatHint: "jpg" }),
      entry({ formatHint: "jpeg" }),
      entry({ formatHint: "png" }),
    ];
    expect(formatCounts(entries)).toEqual([
      { label: "JPEG", count: 2 },
      { label: "PNG", count: 1 },
    ]);
  });
});

describe("timeBuckets", () => {
  it("uses day buckets for short spans, with zero days kept", () => {
    const times = [
      new Date(2024, 2, 1, 10).getTime(),
      new Date(2024, 2, 1, 18).getTime(),
      new Date(2024, 2, 3, 9).getTime(),
    ];
    expect(timeBuckets(times)).toEqual([
      { label: "2024-03-01", count: 2 },
      { label: "2024-03-02", count: 0 },
      { label: "2024-03-03", count: 1 },
    ]);
  });

  it("coarsens to months when days would overflow", () => {
    const times = [new Date(2024, 0, 5).getTime(), new Date(2024, 3, 20).getTime()];
    const buckets = timeBuckets(times, 32);
    expect(buckets.map((b) => b.label)).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(buckets[0]?.count).toBe(1);
    expect(buckets[3]?.count).toBe(1);
  });

  it("coarsens to years for multi-year spans", () => {
    const times = [new Date(2018, 5, 1).getTime(), new Date(2024, 5, 1).getTime()];
    const buckets = timeBuckets(times, 32);
    expect(buckets.map((b) => b.label)).toEqual([
      "2018",
      "2019",
      "2020",
      "2021",
      "2022",
      "2023",
      "2024",
    ]);
  });

  it("ignores zero timestamps and empty input", () => {
    expect(timeBuckets([])).toEqual([]);
    expect(timeBuckets([0])).toEqual([]);
  });
});

describe("cameraCounts", () => {
  const withCamera = (camera: string | null) =>
    meta({ exif: { orientation: 1, dateTime: null, camera } });

  it("counts tagged cameras, skipping untagged", () => {
    const metas = [withCamera("iPhone 15 Pro"), withCamera("iPhone 15 Pro"), withCamera(null)];
    expect(cameraCounts(metas)).toEqual([{ label: "iPhone 15 Pro", count: 2 }]);
  });

  it("folds the tail beyond the top-N into other", () => {
    const metas = [
      ...Array.from({ length: 5 }, () => withCamera("A")),
      withCamera("B"),
      withCamera("C"),
      withCamera("D"),
    ];
    expect(cameraCounts(metas, 3)).toEqual([
      { label: "A", count: 5 },
      { label: "B", count: 1 },
      { label: "other (2)", count: 2 },
    ]);
  });
});

describe("aspectBuckets", () => {
  it("snaps to named ratios regardless of orientation", () => {
    const buckets = aspectBuckets([
      { width: 3000, height: 2000 },
      { width: 2000, height: 3000 },
      { width: 800, height: 800 },
      { width: 1000, height: 313 }, // ~3.2:1 — wider than 2:1
    ]);
    expect(buckets).toEqual([
      { label: "1:1", count: 1 },
      { label: "3:2", count: 2 },
      { label: "wider", count: 1 },
    ]);
  });

  it("labels unsnappable mid-range ratios as other", () => {
    expect(aspectBuckets([{ width: 1400, height: 1000 }])).toEqual([
      { label: "other", count: 1 },
    ]);
  });
});

describe("orientationSplit", () => {
  it("splits landscape, portrait and square", () => {
    expect(
      orientationSplit([
        { width: 2, height: 1 },
        { width: 1, height: 2 },
        { width: 1, height: 2 },
        { width: 3, height: 3 },
      ]),
    ).toEqual({ landscape: 1, portrait: 2, square: 1 });
  });
});

describe("edgeBuckets", () => {
  it("buckets by the longest edge on power-of-two boundaries", () => {
    const buckets = edgeBuckets([
      { width: 1024, height: 768 }, // exactly ≤1024
      { width: 768, height: 1025 }, // long edge is height, next bucket
      { width: 20000, height: 10 },
    ]);
    expect(buckets).toEqual([
      { label: "≤1024", count: 1 },
      { label: "≤2048", count: 1 },
      { label: ">8192", count: 1 },
    ]);
  });
});

describe("sizeBuckets", () => {
  it("buckets sizes and drops empty steps", () => {
    expect(sizeBuckets([50_000, 2_000_000, 2_500_000, 99_000_000])).toEqual([
      { label: "<100 KB", count: 1 },
      { label: "<5 MB", count: 2 },
      { label: "≥20 MB", count: 1 },
    ]);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1400)).toBe("1.4 KB");
    expect(formatBytes(2_300_000)).toBe("2.3 MB");
    expect(formatBytes(150_000_000_000)).toBe("150 GB");
  });
});
