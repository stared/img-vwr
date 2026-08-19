import type { FileEntry, ImageLabels, ImageMeta } from "../ipc";
import { getFilterField } from "../registry/filters";
import type { FieldCtx, RangeSpec } from "../registry/filters";
import { getSort } from "../registry/sorts";
import type { SortDir } from "../registry/sorts";

/* Query state is plain serializable data; the behavior behind sort keys and filter fields lives in the registries. */

export type { SortDir } from "../registry/sorts";

export interface Sort {
  /** A registered sort provider's id ("name", "reddit.hot", …). */
  key: string;
  dir: SortDir;
}

export type Filter =
  | { kind: "format"; formats: string[] } // any-of, by format group id
  | { kind: "name"; substring: string }
  // Keyed by a registered filter field's id; the predicates live in the registry.
  | { kind: "select"; field: string; value: string }
  | { kind: "range"; field: string; from: number; to: number; label: string };

export interface Query {
  filters: Filter[];
  sort: Sort;
}

export const defaultQuery: Query = { filters: [], sort: { key: "name", dir: "asc" } };

/** Keyed by path; total by construction — callers pass every map, so predicates never meet undefined channels. */
export interface QueryData {
  meta: Record<string, ImageMeta>;
  scores: Record<string, number>;
  labels: Record<string, ImageLabels>;
  people: Record<string, string[]>;
}


/** An image nobody labeled: genuinely zero stars-null tags-none, not unknown. */
const EMPTY_LABELS: ImageLabels = { stars: null, tags: [] };

/** Display grouping only, not the openable-format list — an unlisted extension is its own group (see `formatGroupOf`). */
export const FORMAT_GROUPS = [
  { id: "png", label: "PNG", exts: ["png"] },
  { id: "jpeg", label: "JPEG", exts: ["jpg", "jpeg"] },
  { id: "webp", label: "WebP", exts: ["webp"] },
  { id: "gif", label: "GIF", exts: ["gif"] },
  { id: "avif", label: "AVIF", exts: ["avif"] },
] as const;


/** The group an extension filters under — its own extension when no display group claims it. */
function formatGroupOf(ext: string): string {
  const lower = ext.toLowerCase();
  return FORMAT_GROUPS.find((g) => (g.exts as readonly string[]).includes(lower))?.id ?? lower;
}

export function formatGroupLabel(id: string): string {
  return FORMAT_GROUPS.find((g) => g.id === id)?.label ?? id.toUpperCase();
}

/** Metadata filters match only images whose metadata has arrived; a clause whose field is gone matches nothing, not everything. */
function matches(entry: FileEntry, filter: Filter, ctx: FieldCtx): boolean {
  switch (filter.kind) {
    case "format":
      return filter.formats.includes(formatGroupOf(entry.formatHint));
    case "name":
      return entry.name.toLowerCase().includes(filter.substring.toLowerCase());
    case "select": {
      const field = getFilterField(filter.field);
      if (field?.kind === "select") return field.value(entry, ctx) === filter.value;
      if (field?.kind === "flags") return field.values(entry, ctx).includes(filter.value);
      return false;
    }
    case "range": {
      const field = getFilterField(filter.field);
      if (field?.kind !== "range") return false;
      const v = field.spec.value(entry, ctx);
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

export function applyQuery(entries: FileEntry[], query: Query, data: QueryData): FileEntry[] {
  const { meta, scores, labels, people } = data;
  const fieldCtx = (e: FileEntry): FieldCtx => ({
    meta: meta[e.path],
    labels: labels[e.path] ?? EMPTY_LABELS,
    people: people[e.path] ?? [],
  });
  const filtered = query.filters.length
    ? entries.filter((e) => query.filters.every((f) => matches(e, f, fieldCtx(e))))
    : entries;
  const provider = getSort(query.sort.key);
  if (!provider) {
    // Unknown sort (e.g. a plugin's, no longer installed): stable name order.
    return [...filtered].sort((a, b) => naturalCollator.compare(a.name, b.name));
  }
  const sign = query.sort.dir === "asc" ? 1 : -1;
  // The pre-filter position IS the source's own order (scan / API rank).
  const sourceIndex = new Map(entries.map((e, i) => [e.path, i]));
  // Decorate-sort-undecorate: per-comparison map lookups would dominate on tens of thousands of entries.
  const valued = filtered.map((e) => ({
    e,
    v: provider.value(e, {
      meta: meta[e.path],
      sourceIndex: sourceIndex.get(e.path) ?? 0,
      scores,
      labels: labels[e.path] ?? EMPTY_LABELS,
    }),
  }));
  // A ranked view shows only ranked entries; they appear as values land.
  const shown = provider.missing === "hide" ? valued.filter((x) => x.v !== null) : valued;
  return shown
    .sort((a, b) => {
      if (a.v === null || b.v === null) {
        // Unknown values sort last regardless of direction.
        if (a.v === null && b.v === null) return naturalCollator.compare(a.e.name, b.e.name);
        return a.v === null ? 1 : -1;
      }
      return sign * compareValues(a.v, b.v) || naturalCollator.compare(a.e.name, b.e.name);
    })
    .map((x) => x.e);
}

/** True when the active sort reads computed scores from the store. */
export function usesScores(query: Query): boolean {
  return getSort(query.sort.key)?.reads === "scores";
}

function filtersRead(query: Query, channel: "meta" | "labels" | "people"): boolean {
  return query.filters.some((f) => {
    if (f.kind !== "select" && f.kind !== "range") return false;
    const field = getFilterField(f.field);
    return field !== undefined && field.kind !== "action" && field.reads === channel;
  });
}

export function usesMeta(query: Query): boolean {
  return getSort(query.sort.key)?.reads === "meta" || filtersRead(query, "meta");
}

export function usesLabels(query: Query): boolean {
  return getSort(query.sort.key)?.reads === "labels" || filtersRead(query, "labels");
}

export function usesPeople(query: Query): boolean {
  return filtersRead(query, "people");
}

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

/** One clause per field: clicking the active value clears it, another value switches to it. */
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

/* Range-spec factories: the parsing/prefill halves of a RangeSpec, so field definitions only supply the value function. */

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

/** Display unit is `scale` times the stored one (MB → bytes); "=" means within one unit; `integer` rounds to whole units. */
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

interface FormatChoice {
  id: string;
  label: string;
  count: number;
}

/** Present formats first; absent groups stay at zero, and count-then-name keeps the order stable while a scan streams. */
export function formatChoices(entries: readonly FileEntry[]): FormatChoice[] {
  const counts = new Map<string, number>();
  for (const group of FORMAT_GROUPS) counts.set(group.id, 0);
  for (const entry of entries) {
    const id = formatGroupOf(entry.formatHint);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: formatGroupLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
