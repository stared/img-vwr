import type { ComponentType } from "react";

import type { FileEntry, ImageMeta } from "../ipc";
import type { RangeOp } from "../state/query";
import type { Scope } from "../state/store";

/**
 * Filter-field registry — every field the query can filter on. Like sorts,
 * filter options are deliberately not hardcoded: built-ins (format, camera,
 * aspect, taken, …) register here at startup, and sources or plugins add
 * fields the same way, optionally scoped via `appliesTo`. The "+" menu,
 * the chips' edit menus, and the predicate evaluation all resolve through
 * this table.
 *
 * The clause STATE in the query stays plain data keyed by field id; a field
 * provides the BEHAVIOR: how its value is read off an image, how input is
 * parsed, and what menu edits it.
 */

/** A select field buckets each image into a string; clauses match on equality. */
export interface SelectSpec {
  /** The bucket an image belongs to; null = unknown, never matches. */
  value: (entry: FileEntry, meta: ImageMeta | undefined) => string | null;
}

/** A range field compares a numeric value against a half-open [from, to). */
export interface RangeSpec {
  /** Operators that make sense ("=" is useless for file size). */
  ops: RangeOp[];
  input: "date" | "number";
  /** Unit shown next to the value input ("MB", "px"). */
  unit?: string;
  /** The compared value; null = unknown, never matches. */
  value: (entry: FileEntry, meta: ImageMeta | undefined) => number | null;
  /** Operator + typed value → bounds and a chip label; null = unparsable. */
  parse: (op: RangeOp, raw: string) => { from: number; to: number; label: string } | null;
  /** Inverse of parse: prefill the editor from an active clause. */
  initial: (bounds: { from: number; to: number }) => { op: RangeOp; value: string };
}

export interface FilterField {
  id: string;
  /** "+"-menu row label, lowercase like the query language. */
  label: string;
  /** Scopes where this field makes sense; omit = everywhere. */
  appliesTo?: (scope: Scope | null) => boolean;
  /** True when the predicate reads per-image metadata (streams in late). */
  needsMeta?: boolean;
  /** Menu body for the "+" submenu and for editing the field's chip. */
  Menu?: ComponentType<{ close: () => void }>;
  /** Picking the row acts immediately instead of opening a submenu. */
  pick?: () => void;
  select?: SelectSpec;
  range?: RangeSpec;
}

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
  return [...registry.values()].filter((f) => f.appliesTo?.(scope) ?? true);
}

/** Test-only: reset global registry state between test cases. */
export function clearFilterFieldsForTest(): void {
  registry.clear();
}
