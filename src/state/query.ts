import type { FileEntry, ImageMeta } from "../ipc";
import { getSort } from "../registry/sorts";
import type { SortDir } from "../registry/sorts";
import { aspectLabelOf, effectiveDims, takenMs } from "./derived";

/**
 * The gallery is a query over the scanned folder — Linear-style: the folder
 * is the scope (an implicit first filter), explicit filters compose on top,
 * and one sort applies. All fields are already client-side; applying a query
 * is pure and instant.
 *
 * The query STATE is plain serializable data; the BEHAVIOR behind a sort key
 * lives in the sort registry, so sources and plugins can contribute options
 * without touching this module.
 */

export type { SortDir } from "../registry/sorts";

export interface Sort {
  /** A registered sort provider's id ("name", "reddit.hot", …). */
  key: string;
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

/** Numbers numerically, strings naturally; callers put null last themselves. */
function compareValues(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return naturalCollator.compare(String(a), String(b));
}

export function applyQuery(
  entries: FileEntry[],
  query: Query,
  meta: Record<string, ImageMeta> = {},
): FileEntry[] {
  const filtered = query.filters.length
    ? entries.filter((e) => query.filters.every((f) => matches(e, f, meta[e.path])))
    : entries;
  const provider = getSort(query.sort.key);
  if (!provider) {
    // Unknown sort (e.g. a plugin's, no longer installed): stable name order.
    return [...filtered].sort((a, b) => naturalCollator.compare(a.name, b.name));
  }
  const sign = query.sort.dir === "asc" ? 1 : -1;
  // The pre-filter position IS the source's own order (scan / API rank).
  const sourceIndex = new Map(entries.map((e, i) => [e.path, i]));
  const values = new Map<string, number | string | null>(
    filtered.map((e) => [
      e.path,
      provider.value(e, { meta: meta[e.path], sourceIndex: sourceIndex.get(e.path) ?? 0 }),
    ]),
  );
  return [...filtered].sort((a, b) => {
    const va = values.get(a.path) ?? null;
    const vb = values.get(b.path) ?? null;
    if (va === null || vb === null) {
      // Unknown values sort last regardless of direction.
      if (va === null && vb === null) return naturalCollator.compare(a.name, b.name);
      return va === null ? 1 : -1;
    }
    return sign * compareValues(va, vb) || naturalCollator.compare(a.name, b.name);
  });
}

/** True when applying the query needs per-image metadata. */
export function usesMeta(query: Query): boolean {
  if (getSort(query.sort.key)?.needsMeta) return true;
  return query.filters.some(
    (f) =>
      f.kind === "camera" ||
      f.kind === "aspect" ||
      (f.kind === "range" && (f.field === "taken" || f.field === "edge")),
  );
}

/* Pure query editing helpers — the store actions apply these. */

export function withSort(query: Query, key: string): Query {
  const dir: SortDir =
    query.sort.key === key
      ? query.sort.dir === "asc"
        ? "desc"
        : "asc"
      : (getSort(key)?.defaultDir ?? "asc");
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

/* Set variants — editing an existing chip replaces its clause, never clears. */

export function withCameraSet(query: Query, camera: string): Query {
  const others = query.filters.filter((f) => f.kind !== "camera");
  return { ...query, filters: [...others, { kind: "camera", camera }] };
}

export function withAspectSet(query: Query, aspect: string): Query {
  const others = query.filters.filter((f) => f.kind !== "aspect");
  return { ...query, filters: [...others, { kind: "aspect", aspect }] };
}

export function withRangeSet(
  query: Query,
  field: RangeField,
  from: number,
  to: number,
  label: string,
): Query {
  const others = query.filters.filter((f) => !(f.kind === "range" && f.field === field));
  return { ...query, filters: [...others, { kind: "range", field, from, to, label }] };
}

export type RangeOp = "<=" | "=" | ">=";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local ms → "YYYY-MM-DD", for prefilling date inputs. */
export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Operator + typed value → half-open [from, to) range with a chip label.
 * Dates are day-granular ("≤" includes the named day); sizes are megabytes;
 * edges are pixels. Null when the input doesn't parse.
 */
export function rangeFromInput(
  field: RangeField,
  op: RangeOp,
  raw: string,
): { from: number; to: number; label: string } | null {
  const label = (value: string) => `${op === "<=" ? "≤" : op === ">=" ? "≥" : "="} ${value}`;
  if (field === "taken" || field === "modified") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
    if (!m) return null;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!Number.isFinite(day)) return null;
    const next = day + DAY_MS;
    const text = label(raw.trim());
    if (op === ">=") return { from: day, to: Infinity, label: text };
    if (op === "<=") return { from: -Infinity, to: next, label: text };
    return { from: day, to: next, label: text };
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || raw.trim() === "") return null;
  if (field === "size") {
    const bytes = value * 1e6; // decimal MB, matching formatBytes
    const text = label(`${raw.trim()} MB`);
    if (op === ">=") return { from: bytes, to: Infinity, label: text };
    if (op === "<=") return { from: -Infinity, to: bytes + 1, label: text };
    return { from: bytes, to: bytes + 1e6, label: text }; // within that megabyte
  }
  // edge: whole pixels
  const px = Math.round(value);
  const text = label(`${px} px`);
  if (op === ">=") return { from: px, to: Infinity, label: text };
  if (op === "<=") return { from: -Infinity, to: px + 1, label: text };
  return { from: px, to: px + 1, label: text };
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
