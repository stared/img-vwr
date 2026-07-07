import type { FileEntry, ImageMeta } from "../ipc";
import { aspectLabelOf, effectiveDims, takenMs } from "./derived";

/**
 * The gallery is a query over the scanned folder — Linear-style: the folder
 * is the scope (an implicit first filter), explicit filters compose on top,
 * and one sort applies. All fields are already client-side; applying a query
 * is pure and instant.
 */

export type SortKey = "name" | "modified" | "size";
export type SortDir = "asc" | "desc";

export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/** Numeric per-image quantities a range filter can apply to. */
export type RangeField = "taken" | "modified" | "size" | "edge";

export type Filter =
  | { kind: "format"; formats: string[] } // any-of, by format group id
  | { kind: "name"; substring: string }
  | { kind: "camera"; camera: string }
  | { kind: "aspect"; aspect: string }
  | { kind: "range"; field: RangeField; from: number; to: number; label: string };

export interface Query {
  filters: Filter[];
  sort: Sort;
}

export const defaultQuery: Query = { filters: [], sort: { key: "name", dir: "asc" } };

/** Opinionated first-invocation direction per field; invoking again flips. */
export const defaultDirFor: Record<SortKey, SortDir> = {
  name: "asc",
  modified: "desc", // newest first
  size: "desc", // largest first
};

/** Display groups: jpg/jpeg are one thing to a human. */
export const FORMAT_GROUPS = [
  { id: "png", label: "PNG", exts: ["png"] },
  { id: "jpeg", label: "JPEG", exts: ["jpg", "jpeg"] },
  { id: "webp", label: "WebP", exts: ["webp"] },
  { id: "gif", label: "GIF", exts: ["gif"] },
  { id: "avif", label: "AVIF", exts: ["avif"] },
] as const;

export type FormatGroupId = (typeof FORMAT_GROUPS)[number]["id"];

function formatGroupOf(ext: string): string | undefined {
  return FORMAT_GROUPS.find((g) => (g.exts as readonly string[]).includes(ext))?.id;
}

/** The numeric value a range filter compares; null = unknown (never matches). */
function rangeValue(entry: FileEntry, field: RangeField, meta: ImageMeta | undefined): number | null {
  switch (field) {
    case "modified":
      return entry.modifiedMs;
    case "size":
      return entry.size;
    case "taken":
      return meta ? takenMs(meta) : null;
    case "edge": {
      const dims = meta ? effectiveDims(meta) : null;
      return dims ? Math.max(dims.width, dims.height) : null;
    }
  }
}

/**
 * Metadata-based filters (camera, aspect, taken, edge) match only images
 * whose metadata is already known — results refine as the background read
 * streams in, rather than waiting on it.
 */
function matches(entry: FileEntry, filter: Filter, meta: ImageMeta | undefined): boolean {
  switch (filter.kind) {
    case "format": {
      const group = formatGroupOf(entry.formatHint);
      return group !== undefined && filter.formats.includes(group);
    }
    case "name":
      return entry.name.toLowerCase().includes(filter.substring.toLowerCase());
    case "camera":
      return meta?.exif?.camera === filter.camera;
    case "aspect": {
      const dims = meta ? effectiveDims(meta) : null;
      return dims !== null && aspectLabelOf(dims) === filter.aspect;
    }
    case "range": {
      const v = rangeValue(entry, filter.field, meta);
      return v !== null && v >= filter.from && v < filter.to;
    }
  }
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareBy(sort: Sort, a: FileEntry, b: FileEntry): number {
  const sign = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "name":
      return sign * naturalCollator.compare(a.name, b.name);
    case "modified":
      return sign * (a.modifiedMs - b.modifiedMs) || naturalCollator.compare(a.name, b.name);
    case "size":
      return sign * (a.size - b.size) || naturalCollator.compare(a.name, b.name);
  }
}

export function applyQuery(
  entries: FileEntry[],
  query: Query,
  meta: Record<string, ImageMeta> = {},
): FileEntry[] {
  const filtered = query.filters.length
    ? entries.filter((e) => query.filters.every((f) => matches(e, f, meta[e.path])))
    : entries;
  return [...filtered].sort((a, b) => compareBy(query.sort, a, b));
}

/** True when any filter needs per-image metadata to evaluate. */
export function usesMeta(query: Query): boolean {
  return query.filters.some(
    (f) =>
      f.kind === "camera" ||
      f.kind === "aspect" ||
      (f.kind === "range" && (f.field === "taken" || f.field === "edge")),
  );
}

/* Pure query editing helpers — the store actions apply these. */

export function withSort(query: Query, key: SortKey): Query {
  const dir: SortDir =
    query.sort.key === key
      ? query.sort.dir === "asc"
        ? "desc"
        : "asc"
      : defaultDirFor[key];
  return { ...query, sort: { key, dir } };
}

export function withFormatToggled(query: Query, group: string): Query {
  const existing = query.filters.find((f) => f.kind === "format");
  const formats = existing?.kind === "format" ? existing.formats : [];
  const next = formats.includes(group)
    ? formats.filter((g) => g !== group)
    : [...formats, group];
  const others = query.filters.filter((f) => f.kind !== "format");
  return {
    ...query,
    filters: next.length ? [...others, { kind: "format", formats: next }] : others,
  };
}

export function withNameFilter(query: Query, substring: string): Query {
  const others = query.filters.filter((f) => f.kind !== "name");
  return {
    ...query,
    filters: substring ? [...others, { kind: "name", substring }] : others,
  };
}

/**
 * One clause per key: clicking a value sets it, clicking the active value
 * clears it, clicking another value switches to it.
 */
export function withCameraToggled(query: Query, camera: string): Query {
  const active = query.filters.some((f) => f.kind === "camera" && f.camera === camera);
  const others = query.filters.filter((f) => f.kind !== "camera");
  return { ...query, filters: active ? others : [...others, { kind: "camera", camera }] };
}

export function withAspectToggled(query: Query, aspect: string): Query {
  const active = query.filters.some((f) => f.kind === "aspect" && f.aspect === aspect);
  const others = query.filters.filter((f) => f.kind !== "aspect");
  return { ...query, filters: active ? others : [...others, { kind: "aspect", aspect }] };
}

/** Range filters are keyed by field — one taken-range, one size-range, etc. */
export function withRangeToggled(
  query: Query,
  field: RangeField,
  from: number,
  to: number,
  label: string,
): Query {
  const active = query.filters.some(
    (f) => f.kind === "range" && f.field === field && f.from === from && f.to === to,
  );
  const others = query.filters.filter((f) => !(f.kind === "range" && f.field === field));
  return {
    ...query,
    filters: active ? others : [...others, { kind: "range", field, from, to, label }],
  };
}

export function withoutFilters(query: Query): Query {
  return { ...query, filters: [] };
}

export function withoutFormats(query: Query): Query {
  return { ...query, filters: query.filters.filter((f) => f.kind !== "format") };
}

export function nameFilterText(query: Query): string {
  const f = query.filters.find((f) => f.kind === "name");
  return f?.kind === "name" ? f.substring : "";
}

export function activeFormats(query: Query): string[] {
  const f = query.filters.find((f) => f.kind === "format");
  return f?.kind === "format" ? f.formats : [];
}
