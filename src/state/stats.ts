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

const EDGE_LIMITS = [256, 512, 1024, 2048, 4096, 8192] as const;

/** Longest-edge histogram in power-of-two steps; zero buckets dropped. */
export function edgeBuckets(dims: readonly Dims[]): Bucket[] {
  const labels = [...EDGE_LIMITS.map((l) => `≤${l}`), `>${EDGE_LIMITS[EDGE_LIMITS.length - 1]}`];
  const counts = labels.map((label) => ({ label, count: 0 }));
  for (const { width, height } of dims) {
    const edge = Math.max(width, height);
    const i = EDGE_LIMITS.findIndex((limit) => edge <= limit);
    const bucket = counts[i === -1 ? counts.length - 1 : i];
    if (bucket) bucket.count += 1;
  }
  return counts.filter((b) => b.count > 0);
}

const SIZE_STEPS = [
  { label: "<100 KB", max: 100_000 },
  { label: "<500 KB", max: 500_000 },
  { label: "<1 MB", max: 1_000_000 },
  { label: "<5 MB", max: 5_000_000 },
  { label: "<20 MB", max: 20_000_000 },
  { label: "≥20 MB", max: Infinity },
] as const;

/** File-size histogram over fixed steps; zero buckets dropped. */
export function sizeBuckets(sizes: readonly number[]): Bucket[] {
  const counts = SIZE_STEPS.map(({ label }) => ({ label, count: 0 }));
  for (const size of sizes) {
    const i = SIZE_STEPS.findIndex((step) => size < step.max);
    const bucket = counts[i === -1 ? counts.length - 1 : i];
    if (bucket) bucket.count += 1;
  }
  return counts.filter((b) => b.count > 0);
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
