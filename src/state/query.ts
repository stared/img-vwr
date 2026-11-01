import type { FileEntry } from "../ipc";
import { photoData, type Channel, type ChannelMaps, type PhotoData } from "../registry/channels";
import { getFilterField } from "../registry/filters";
import type { RangeSpec } from "../registry/filters";
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
  // Matches when any of `values` is present ("any": some value at all); `negate` inverts.
  | { kind: "select"; field: string; values: SelectValues; negate: boolean }
  // `label` names the value only; the operator is read back from the bounds.
  | { kind: "range"; field: string; from: number; to: number; label: string };

export type SelectValues = "any" | string[];

export interface Query {
  filters: Filter[];
  sort: Sort;
}

export const defaultQuery: Query = { filters: [], sort: { key: "name", dir: "asc" } };


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
function matches(entry: FileEntry, filter: Filter, ctx: PhotoData): boolean {
  switch (filter.kind) {
    case "format":
      return filter.formats.includes(formatGroupOf(entry.formatHint));
    case "name":
      return entry.name.toLowerCase().includes(filter.substring.toLowerCase());
    case "select": {
      const field = getFilterField(filter.field);
      const { values } = filter;
      if (field?.kind === "select") {
        const v = field.value(entry, ctx);
        return v !== null && (values === "any" || values.includes(v)) !== filter.negate;
      }
      if (field?.kind === "flags") {
        const has = field.values(entry, ctx);
        const hit = values === "any" ? has.length > 0 : has.some((v) => values.includes(v));
        return hit !== filter.negate;
      }
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

/** `maps` holds the channels the query reads (see `channelsRead`); any other channel reads as missing. */
export function applyQuery(entries: FileEntry[], query: Query, maps: ChannelMaps): FileEntry[] {
  const filtered = query.filters.length
    ? entries.filter((e) => {
        const data = photoData(maps, e.path);
        return query.filters.every((f) => matches(e, f, data));
      })
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
      ...photoData(maps, e.path),
      sourceIndex: sourceIndex.get(e.path) ?? 0,
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

/** Every channel the active sort and clauses read, in a stable order: only these may invalidate the visible list. */
export function channelsRead(query: Query): Channel<unknown>[] {
  const read = new Set<Channel<unknown>>(getSort(query.sort.key)?.reads ?? []);
  for (const f of query.filters) {
    if (f.kind !== "select" && f.kind !== "range") continue;
    const field = getFilterField(f.field);
    if (field !== undefined && field.kind !== "action") for (const c of field.reads) read.add(c);
  }
  return [...read];
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

function selectClause(query: Query, field: string) {
  const f = query.filters.find((f) => f.kind === "select" && f.field === field);
  return f?.kind === "select" ? f : undefined;
}

export function isPicked(query: Query, field: string, value: string): boolean {
  const values = selectClause(query, field)?.values;
  return Array.isArray(values) && values.includes(value);
}

export function isAnyPicked(query: Query, field: string): boolean {
  return selectClause(query, field)?.values === "any";
}

/** One clause per field, edited in place; no values left drops it. */
function withSelectValues(query: Query, field: string, values: SelectValues | null): Query {
  const current = selectClause(query, field);
  if (values === null || values.length === 0) {
    return withSelectCleared(query, field);
  }
  if (current === undefined) {
    return { ...query, filters: [...query.filters, { kind: "select", field, values, negate: false }] };
  }
  return {
    ...query,
    filters: query.filters.map((f) => (f === current ? { ...current, values } : f)),
  };
}

export function withSelectToggled(query: Query, field: string, value: string): Query {
  const values = selectClause(query, field)?.values ?? [];
  if (values === "any") return withSelectValues(query, field, [value]);
  return withSelectValues(
    query,
    field,
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value],
  );
}

/** The any-value row replaces a list of values, and clears itself. */
export function withSelectAnyToggled(query: Query, field: string): Query {
  return withSelectValues(query, field, isAnyPicked(query, field) ? null : "any");
}

/** A value that changed its name (a person named) stays picked under the new one. */
export function withSelectRenamed(query: Query, field: string, from: string, to: string): Query {
  const values = selectClause(query, field)?.values;
  if (values === undefined || values === "any") return query;
  return withSelectValues(query, field, values.map((v) => (v === from ? to : v)));
}

export function withSelectCleared(query: Query, field: string): Query {
  return {
    ...query,
    filters: query.filters.filter((f) => !(f.kind === "select" && f.field === field)),
  };
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

export function withSelectNegated(query: Query, field: string): Query {
  return {
    ...query,
    filters: query.filters.map((f) =>
      f.kind === "select" && f.field === field ? { ...f, negate: !f.negate } : f,
    ),
  };
}

/** The same value under another operator: ≥ 3 → = 3. */
export function withRangeOp(query: Query, field: string, op: RangeOp): Query {
  const spec = getFilterField(field);
  if (spec?.kind !== "range") return query;
  return {
    ...query,
    filters: query.filters.map((f) => {
      if (f.kind !== "range" || f.field !== field) return f;
      const bounds = spec.spec.parse(op, spec.spec.initial(f).value);
      return bounds === null ? f : { ...f, from: bounds.from, to: bounds.to };
    }),
  };
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

export const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

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
      const label = raw.trim();
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
      const label = `${units} ${unit}`;
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
