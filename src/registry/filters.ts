import type { ComponentType } from "react";

import type { FileEntry, ImageLabels, ImageMeta } from "../ipc";
import type { RangeOp } from "../state/query";
import type { Scope } from "../state/store";

interface FieldBase {
  id: string;
  /** "+"-menu row label, lowercase like the query language. */
  label: string;
  appliesTo: (scope: Scope | null) => boolean;
}

/** Drives which streaming store slices invalidate the visible list. */
export type FieldReads = "entry" | "meta" | "labels" | "people";

/** meta is undefined until the background read lands; labels and people are total — empty, never unknown. */
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

/** Multi-valued select; the clause matches when its value is among the image's. */
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

export function clearFilterFieldsForTest(): void {
  registry.clear();
}
