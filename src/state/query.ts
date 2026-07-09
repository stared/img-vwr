import type { FileEntry, ImageMeta } from "../ipc";
import { getFilterField } from "../registry/filters";
import type { RangeSpec } from "../registry/filters";
import { getSort } from "../registry/sorts";
import type { SortDir } from "../registry/sorts";

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

export type Filter =
  | { kind: "format"; formats: string[] } // any-of, by format group id
  | { kind: "name"; substring: string }
  // Select and range clauses are keyed by a registered filter field's id
  // ("camera", "aspect", "taken", …) — their predicates live in the registry.
  | { kind: "select"; field: string; value: string }
  | { kind: "range"; field: string; from: number; to: number; label: string };

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

/**
 * Metadata-based filters (camera, aspect, taken, edge) match only images
 * whose metadata is already known — results refine as the background read
 * streams in, rather than waiting on it. Select and range predicates resolve
 * through the filter-field registry; a clause whose field is gone (e.g. an
 * uninstalled plugin's) matches nothing rather than everything.
 */
function matches(entry: FileEntry, filter: Filter, meta: ImageMeta | undefined): boolean {
  switch (filter.kind) {
    case "format": {
      const group = formatGroupOf(entry.formatHint);
      return group !== undefined && filter.formats.includes(group);
    }
    case "name":
      return entry.name.toLowerCase().includes(filter.substring.toLowerCase());
    case "select": {
      const field = getFilterField(filter.field);
      if (field?.kind !== "select") return false;
      return field.value(entry, meta) === filter.value;
    }
    case "range": {
      const field = getFilterField(filter.field);
      if (field?.kind !== "range") return false;
      const v = field.spec.value(entry, meta);
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
  scores: Record<string, number> = {},
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
      provider.value(e, {
        meta: meta[e.path],
        sourceIndex: sourceIndex.get(e.path) ?? 0,
        scores,
      }),
    ]),
  );
  // A ranked view shows only ranked entries; they appear as values land.
  const shown =
    provider.missing === "hide"
      ? filtered.filter((e) => (values.get(e.path) ?? null) !== null)
      : filtered;
  return [...shown].sort((a, b) => {
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

/** True when the active sort reads computed scores from the store. */
export function usesScores(query: Query): boolean {
  return getSort(query.sort.key)?.reads === "scores";
}

/** True when applying the query needs per-image metadata. */
export function usesMeta(query: Query): boolean {
  if (getSort(query.sort.key)?.reads === "meta") return true;
  return query.filters.some((f) => {
    if (f.kind !== "select" && f.kind !== "range") return false;
    const field = getFilterField(f.field);
    return field !== undefined && field.kind !== "action" && field.needsMeta;
  });
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
 * One clause per field: clicking a value sets it, clicking the active value
 * clears it, clicking another value switches to it.
 */
export function withSelectToggled(query: Query, field: string, value: string): Query {
  const active = query.filters.some(
    (f) => f.kind === "select" && f.field === field && f.value === value,
  );
  const others = query.filters.filter((f) => !(f.kind === "select" && f.field === field));
  return { ...query, filters: active ? others : [...others, { kind: "select", field, value }] };
}

/** Range filters are keyed by field — one taken-range, one size-range, etc. */
export function withRangeToggled(
  query: Query,
  field: string,
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

export function withSelectSet(query: Query, field: string, value: string): Query {
  const others = query.filters.filter((f) => !(f.kind === "select" && f.field === field));
  return { ...query, filters: [...others, { kind: "select", field, value }] };
}

export function withRangeSet(
  query: Query,
  field: string,
  from: number,
  to: number,
  label: string,
): Query {
  const others = query.filters.filter((f) => !(f.kind === "range" && f.field === field));
  return { ...query, filters: [...others, { kind: "range", field, from, to, label }] };
}

export type RangeOp = "<=" | "=" | ">=";

const DAY_MS = 24 * 60 * 60 * 1000;

const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

/** Local ms → "YYYY-MM-DD", for prefilling date inputs. */
export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* Range-spec factories — the parsing/prefill halves of a RangeSpec, so
 * field definitions (built-in or plugin) only supply the value function. */

/** Day-granular date range: "≤" and "=" include the named day. */
export function dateRangeSpec(value: RangeSpec["value"]): RangeSpec {
  return {
    ops: ["<=", "=", ">="],
    input: "date",
    unit: null,
    value,
    parse: (op, raw) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
      if (!m) return null;
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (!Number.isFinite(day)) return null;
      const label = `${OP_SYMBOL[op]} ${raw.trim()}`;
      if (op === ">=") return { from: day, to: Infinity, label };
      if (op === "<=") return { from: -Infinity, to: day + DAY_MS, label };
      return { from: day, to: day + DAY_MS, label };
    },
    initial: ({ from, to }) =>
      from === -Infinity
        ? { op: "<=", value: dateInputValue(to - DAY_MS) }
        : { op: to === Infinity ? ">=" : "=", value: dateInputValue(from) },
  };
}

/**
 * Numeric range in a display unit `scale` times the stored one (MB → bytes);
 * "=" means within one unit. `integer` rounds input to whole units (pixels).
 */
export function numberRangeSpec(
  value: RangeSpec["value"],
  opts: { unit: string; scale: number; integer: boolean; ops: RangeOp[] },
): RangeSpec {
  const { unit, scale, integer, ops } = opts;
  const fromInput = (raw: string): number | null => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0 || raw.trim() === "") return null;
    return integer ? Math.round(n) : n;
  };
  const toInput = (stored: number): string =>
    integer ? String(Math.round(stored / scale)) : String(Number((stored / scale).toFixed(2)));
  return {
    ops,
    input: "number",
    unit,
    value,
    parse: (op, raw) => {
      const units = fromInput(raw);
      if (units === null) return null;
      const stored = units * scale;
      const label = `${OP_SYMBOL[op]} ${units} ${unit}`;
      if (op === ">=") return { from: stored, to: Infinity, label };
      if (op === "<=") return { from: -Infinity, to: stored + 1, label };
      return { from: stored, to: stored + Math.max(scale, 1), label };
    },
    initial: ({ from, to }) =>
      from === -Infinity
        ? { op: "<=", value: toInput(to - 1) }
        : { op: to === Infinity ? ">=" : "=", value: toInput(from) },
  };
}

/** Parse an input against a registered range field; null if either is invalid. */
export function rangeFromInput(
  fieldId: string,
  op: RangeOp,
  raw: string,
): { from: number; to: number; label: string } | null {
  const field = getFilterField(fieldId);
  if (field?.kind !== "range") return null;
  return field.spec.parse(op, raw);
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
