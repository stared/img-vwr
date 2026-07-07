import type { FileEntry } from "../ipc";
import type { ImageMeta } from "../ipc/bindings";
import { FORMAT_GROUPS } from "./query";

/**
 * Collection statistics — pure functions over the visible entries and the
 * per-image metadata streamed in from Rust. Everything here returns labelled
 * buckets the stats panel renders as bars.
 */

export interface Bucket {
  label: string;
  count: number;
}

export interface Dims {
  width: number;
  height: number;
}

/** Parse an EXIF datetime ("2023:05:12 14:33:21", also "-" separators) → ms, or null. */
export function parseExifDate(value: string): number | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isFinite(t) && Number(y) > 0 ? t : null;
}

/** Display dimensions: EXIF orientations 5–8 mean the pixels are stored rotated. */
export function effectiveDims(meta: ImageMeta): Dims | null {
  if (meta.width === null || meta.height === null) return null;
  const swapped = (meta.exif?.orientation ?? 1) >= 5;
  return swapped
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

/** Count per format group (jpg/jpeg fold into JPEG), most common first. */
export function formatCounts(entries: readonly FileEntry[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const group = FORMAT_GROUPS.find((g) =>
      (g.exts as readonly string[]).includes(entry.formatHint),
    );
    const label = group?.label ?? entry.formatHint.toUpperCase();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
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

/**
 * Contiguous time histogram (zero buckets kept — the shape is the point) at
 * the finest of day/month/year granularity that fits in `maxBuckets`.
 */
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
      buckets.push({ label: bucketLabel(unit, cursor), count: 0 });
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
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  if (sorted.length <= top) return sorted;
  const rest = sorted.slice(top - 1);
  return [
    ...sorted.slice(0, top - 1),
    { label: `other (${rest.length})`, count: rest.reduce((sum, b) => sum + b.count, 0) },
  ];
}

const NAMED_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "5:4", value: 5 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:10", value: 16 / 10 },
  { label: "16:9", value: 16 / 9 },
  { label: "2:1", value: 2 },
] as const;

/** Relative tolerance for snapping a measured ratio to a named one. */
const RATIO_TOLERANCE = 0.04;

/** Nearest named ratio of long/short edge, or "other"; ordered square → widest. */
export function aspectBuckets(dims: readonly Dims[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const { width, height } of dims) {
    if (width <= 0 || height <= 0) continue;
    const ratio = Math.max(width, height) / Math.min(width, height);
    let best: { label: string; error: number } | null = null;
    for (const named of NAMED_RATIOS) {
      const error = Math.abs(ratio - named.value) / named.value;
      if (error <= RATIO_TOLERANCE && (best === null || error < best.error)) {
        best = { label: named.label, error };
      }
    }
    const label = best?.label ?? (ratio > 2 ? "wider" : "other");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = [...NAMED_RATIOS.map((r) => r.label), "wider", "other"];
  return order
    .map((label) => ({ label, count: counts.get(label) ?? 0 }))
    .filter((b) => b.count > 0);
}

export interface OrientationSplit {
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

/** Smallest "nice" step (1/2/5 × 10^k) that is ≥ raw. */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const mult of [1, 2, 5]) {
    if (raw <= mult * pow) return mult * pow;
  }
  return 10 * pow;
}

/** Uniform bins with a nice width covering the data range; bin labels are ranges. */
export function linearBins(
  values: readonly number[],
  maxBins = 24,
  fmt: (n: number) => string = String,
): NumericHistogram | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  let min = valid[0] ?? 0;
  let max = min;
  for (const v of valid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return { bins: [{ label: fmt(min), count: valid.length }], minLabel: fmt(min), maxLabel: fmt(max) };
  }
  const width = niceStep((max - min) / maxBins);
  const start = Math.floor(min / width) * width;
  const binCount = Math.floor((max - start) / width) + 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    label: `${fmt(start + i * width)}–${fmt(start + (i + 1) * width)}`,
    count: 0,
  }));
  for (const v of valid) {
    const bin = bins[Math.min(binCount - 1, Math.floor((v - start) / width))];
    if (bin) bin.count += 1;
  }
  return { bins, minLabel: fmt(min), maxLabel: fmt(max) };
}

/** Bins doubling in width (one per power of two) — for heavy-tailed values like file sizes. */
export function log2Bins(
  values: readonly number[],
  fmt: (n: number) => string = String,
): NumericHistogram | null {
  const valid = values.filter((v) => v > 0);
  if (valid.length === 0) return null;
  let min = valid[0] ?? 1;
  let max = min;
  for (const v of valid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const lo = Math.floor(Math.log2(min));
  const binCount = Math.floor(Math.log2(max)) - lo + 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    label: `${fmt(2 ** (lo + i))}–${fmt(2 ** (lo + i + 1))}`,
    count: 0,
  }));
  for (const v of valid) {
    const bin = bins[Math.min(binCount - 1, Math.floor(Math.log2(v)) - lo)];
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
