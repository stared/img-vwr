import type { FileEntry } from "../ipc";
import type { ImageMeta } from "../ipc/bindings";
import type { Dims } from "./derived";
import { aspectLabelOf } from "./derived";
import { formatChoices } from "./query";

export interface Bucket {
  label: string;
  count: number;
  /** The filterable value behind this bucket; absent for fold-ups like "other (3)". */
  value?: string;
  /** Half-open numeric range [from, to) behind a histogram bin. */
  from?: number;
  to?: number;
}

/** Count per format group (jpg/jpeg fold into JPEG), most common first; zero-count formats excluded (the menu keeps them). */
export function formatCounts(entries: readonly FileEntry[]): Bucket[] {
  return formatChoices(entries)
    .filter((c) => c.count > 0)
    .map((c) => ({ label: c.label, count: c.count, value: c.id }));
}

type TimeUnit = "day" | "month" | "year";

function bucketStart(unit: TimeUnit, date: Date): Date {
  switch (unit) {
    case "day":
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    case "month":
      return new Date(date.getFullYear(), date.getMonth(), 1);
    case "year":
      return new Date(date.getFullYear(), 0, 1);
  }
}

function bucketNext(unit: TimeUnit, start: Date): Date {
  switch (unit) {
    case "day":
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    case "month":
      return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    case "year":
      return new Date(start.getFullYear() + 1, 0, 1);
  }
}

function bucketLabel(unit: TimeUnit, start: Date): string {
  const y = String(start.getFullYear());
  const mo = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  switch (unit) {
    case "day":
      return `${y}-${mo}-${d}`;
    case "month":
      return `${y}-${mo}`;
    case "year":
      return y;
  }
}

/** Contiguous time histogram (zero buckets kept) at the finest of day/month/year that fits `maxBuckets`. */
export function timeBuckets(timesMs: readonly number[], maxBuckets = 32): Bucket[] {
  const valid = timesMs.filter((t) => t > 0);
  if (valid.length === 0) return [];
  let min = valid[0] ?? 0;
  let max = min;
  for (const t of valid) {
    if (t < min) min = t;
    if (t > max) max = t;
  }

  for (const unit of ["day", "month", "year"] as const) {
    const buckets: Bucket[] = [];
    for (
      let cursor = bucketStart(unit, new Date(min));
      cursor.getTime() <= max;
      cursor = bucketNext(unit, cursor)
    ) {
      buckets.push({
        label: bucketLabel(unit, cursor),
        count: 0,
        from: cursor.getTime(),
        to: bucketNext(unit, cursor).getTime(),
      });
      if (buckets.length > maxBuckets && unit !== "year") break;
    }
    if (buckets.length > maxBuckets && unit !== "year") continue;

    const index = new Map(buckets.map((b, i) => [b.label, i]));
    for (const t of valid) {
      const i = index.get(bucketLabel(unit, bucketStart(unit, new Date(t))));
      const bucket = i !== undefined ? buckets[i] : undefined;
      if (bucket) bucket.count += 1;
    }
    return buckets;
  }
  return [];
}

/** Top camera models by count; the tail folds into "other", untagged excluded. */
export function cameraCounts(metas: readonly ImageMeta[], top = 8): Bucket[] {
  const counts = new Map<string, number>();
  for (const meta of metas) {
    const camera = meta.exif?.camera;
    if (camera) counts.set(camera, (counts.get(camera) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ label, count, value: label }))
    .sort((a, b) => b.count - a.count);
  if (sorted.length <= top) return sorted;
  const rest = sorted.slice(top - 1);
  return [
    ...sorted.slice(0, top - 1),
    { label: `other (${rest.length})`, count: rest.reduce((sum, b) => sum + b.count, 0) },
  ];
}

/** Named ratios sort by count; the catch-alls "wider" and "other" always trail. */
export function aspectBuckets(dims: readonly Dims[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const d of dims) {
    const label = aspectLabelOf(d);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const catchAlls = ["wider", "other"];
  const named = [...counts.entries()]
    .filter(([label]) => !catchAlls.includes(label))
    .map(([label, count]) => ({ label, count, value: label }))
    .sort((a, b) => b.count - a.count);
  const rest = catchAlls
    .map((label) => ({ label, count: counts.get(label) ?? 0, value: label }))
    .filter((b) => b.count > 0);
  return [...named, ...rest];
}

interface OrientationSplit {
  landscape: number;
  portrait: number;
  square: number;
}

export function orientationSplit(dims: readonly Dims[]): OrientationSplit {
  const split = { landscape: 0, portrait: 0, square: 0 };
  for (const { width, height } of dims) {
    if (width > height) split.landscape += 1;
    else if (height > width) split.portrait += 1;
    else split.square += 1;
  }
  return split;
}

/** A binned distribution: contiguous bins (zeros kept) plus data min/max for the axis. */
export interface NumericHistogram {
  bins: Bucket[];
  minLabel: string;
  maxLabel: string;
}

/** Log-scale bins for heavy-tailed values; `binsPerOctave` 1 means bins doubling in width. */
export function log2Bins(
  values: readonly number[],
  fmt: (n: number) => string = String,
  binsPerOctave = 1,
): NumericHistogram | null {
  const valid = values.filter((v) => v > 0);
  if (valid.length === 0) return null;
  let min = valid[0] ?? 1;
  let max = min;
  for (const v of valid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const slot = (v: number) => Math.floor(Math.log2(v) * binsPerOctave);
  const edge = (s: number) => 2 ** (s / binsPerOctave);
  const lo = slot(min);
  const binCount = slot(max) - lo + 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    label: `${fmt(edge(lo + i))}–${fmt(edge(lo + i + 1))}`,
    count: 0,
    from: edge(lo + i),
    to: edge(lo + i + 1),
  }));
  for (const v of valid) {
    const bin = bins[Math.min(binCount - 1, slot(v) - lo)];
    if (bin) bin.count += 1;
  }
  return { bins, minLabel: fmt(min), maxLabel: fmt(max) };
}

/** "1.4 MB"-style human size (decimal units, one decimal below 100). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  for (const unit of ["KB", "MB", "GB", "TB"]) {
    value /= 1000;
    if (value < 1000) {
      return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${unit}`;
    }
  }
  return `${(value / 1000).toFixed(1)} PB`;
}
