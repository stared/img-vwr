import type { ComponentType } from "react";

import type { FileEntry } from "../ipc";
import type { PhotoData, Reads } from "./channels";
import type { Scope } from "../state/store";

export type SortDir = "asc" | "desc";

export interface SortValueContext extends PhotoData {
  /** Position as delivered: scan order for folders, API rank for sources. */
  sourceIndex: number;
}

/** One chip token; plain `text` tokens open the sort menu like the rest of the chip. */
export type SortChipSegment =
  | { kind: "text"; text: string }
  | {
      kind: "edit";
      text: string;
      prefill: string;
      placeholder: string;
      commit: (value: string) => void;
    }
  | { kind: "menu"; text: string; Menu: ComponentType<{ close: () => void }> };

export interface SortParam {
  segments: () => SortChipSegment[];
  /** Menu row while the parameter is unset; picking it opens the chip's first `edit` token. */
  collectLabel: string;
  collectHint: string;
  isSet: () => boolean;
  /** Drops the parameter and with it the sort; rendered as the chip's ×. */
  clear: () => void;
}

export interface SortProvider {
  id: string;
  /** Query-language label, lowercase; the chip reads "sort: {label}". */
  label: string;
  hints: { asc: string; desc: string };
  /** Direction the first invocation uses; invoking again flips. */
  defaultDir: SortDir;
  appliesTo: (scope: Scope | null) => boolean;
  reads: Reads;
  /** What a null value means: sort those entries last, or hide them from the visible list. */
  missing: "last" | "hide";
  /** null for plain sorts (which survive scope changes); parameterized sorts reset with the scope. */
  param: SortParam | null;
  /** Numbers compare numerically, strings naturally (case-insensitive, numeric-aware). */
  value: (entry: FileEntry, ctx: SortValueContext) => number | string | null;
}

const registry = new Map<string, SortProvider>();

export function registerSort(provider: SortProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(`sort already registered: ${provider.id}`);
  }
  registry.set(provider.id, provider);
}

export function getSort(id: string): SortProvider | undefined {
  return registry.get(id);
}

export function allSorts(): SortProvider[] {
  return [...registry.values()];
}

/** The sorts offered for a scope, in registration order. */
export function sortsFor(scope: Scope | null): SortProvider[] {
  return allSorts().filter((p) => p.appliesTo(scope));
}

export function clearSortsForTest(): void {
  registry.clear();
}
