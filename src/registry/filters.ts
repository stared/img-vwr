import type { ComponentType } from "react";

import type { FileEntry, ImageLabels, ImageMeta } from "../ipc";
import type { RangeOp } from "../state/query";
import type { Scope } from "../state/store";

/**
 * Filter-field registry — every field the query can filter on. Like sorts,
 * filter options are deliberately not hardcoded: built-ins (format, camera,
 * aspect, taken, …) register here at startup, and sources or plugins add
 * fields the same way, scoped via `appliesTo`. The "+" menu, the chips'
 * edit menus, and the predicate evaluation all resolve through this table.
 *
 * The contract is TOTAL: a field is exactly one of four kinds, each with
 * every behavior it needs — no optional hooks, no fallback rendering.
 * The clause STATE in the query stays plain data keyed by field id.
 */

interface FieldBase {
  id: string;
  /** "+"-menu row label, lowercase like the query language. */
  label: string;
  /** Scopes where this field makes sense. */
  appliesTo: (scope: Scope | null) => boolean;
}

/** What a field's predicate reads beyond the entry itself; drives which
 * streaming store slices invalidate the visible list. */
export type FieldReads = "entry" | "meta" | "labels" | "people";

/** Per-entry data a predicate can read. Meta is undefined until the
 * background read delivers it; labels are TOTAL — an unlabeled image is
 * the empty label set, not an unknown. People are the person-cluster ids
 * the face pass put this photo in — empty until faces are found. */
export interface FieldCtx {
  meta: ImageMeta | undefined;
  labels: ImageLabels;
  people: string[];
}

/** Picking the row acts immediately (e.g. opens an inline input). */
export type ActionField = FieldBase & {
  kind: "action";
  pick: () => void;
};

/** A custom submenu with its own clause handling (e.g. format multi-toggle). */
export type MenuField = FieldBase & {
  kind: "menu";
  /** Right-side hint in the "+" menu. */
  hint: string;
  reads: FieldReads;
  Menu: ComponentType<{ close: () => void }>;
};

/** Buckets each image into a string; the clause matches on equality. */
export type SelectField = FieldBase & {
  kind: "select";
  reads: FieldReads;
  Menu: ComponentType<{ close: () => void }>;
  /** The bucket an image belongs to; null = unknown, never matches. */
  value: (entry: FileEntry, ctx: FieldCtx) => string | null;
};

/** Multi-valued select (tags): each image has a set of values and the
 * clause matches when its value is one of them. */
export type FlagsField = FieldBase & {
  kind: "flags";
  reads: FieldReads;
  Menu: ComponentType<{ close: () => void }>;
  values: (entry: FileEntry, ctx: FieldCtx) => string[];
};

/** Compares a numeric value against a half-open [from, to). */
export type RangeField = FieldBase & {
  kind: "range";
  reads: FieldReads;
  Menu: ComponentType<{ close: () => void }>;
  spec: RangeSpec;
};

export interface RangeSpec {
  /** Operators that make sense ("=" is useless for file size). */
  ops: RangeOp[];
  input: "date" | "number";
  /** Unit shown next to the value input ("MB", "px"); null for dates. */
  unit: string | null;
  /** The compared value; null = unknown, never matches. */
  value: (entry: FileEntry, ctx: FieldCtx) => number | null;
  /** Operator + typed value → bounds and a chip label; null = unparsable. */
  parse: (op: RangeOp, raw: string) => { from: number; to: number; label: string } | null;
  /** Inverse of parse: prefill the editor from an active clause. */
  initial: (bounds: { from: number; to: number }) => { op: RangeOp; value: string };
}

export type FilterField = ActionField | MenuField | SelectField | FlagsField | RangeField;

const registry = new Map<string, FilterField>();

export function registerFilterField(field: FilterField): void {
  if (registry.has(field.id)) {
    throw new Error(`filter field already registered: ${field.id}`);
  }
  registry.set(field.id, field);
}

export function getFilterField(id: string): FilterField | undefined {
  return registry.get(id);
}

/** The filter fields offered for a scope, in registration order. */
export function filterFieldsFor(scope: Scope | null): FilterField[] {
  return [...registry.values()].filter((f) => f.appliesTo(scope));
}

/** Test-only: reset global registry state between test cases. */
export function clearFilterFieldsForTest(): void {
  registry.clear();
}
