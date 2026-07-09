import type { ComponentType } from "react";

import type { FileEntry, ImageMeta } from "../ipc";
import type { Scope } from "../state/store";

/**
 * Sort registry — every way a collection can be ordered. Sort options are
 * deliberately not hardcoded anywhere: the built-ins (name, modified, size)
 * register here at startup, sources contribute orders that only exist on
 * their collections (Reddit's hot rank, Commons' search relevance), and
 * plugins register into the same table. The sort menu, chip, and palette
 * commands are all derived from this table, filtered by scope.
 *
 * The contract is TOTAL — no optional fields, no fallbacks. Every provider
 * states where it applies, what its value reads, and whether it is
 * parameterized; inconsistent partial combinations cannot be expressed.
 */

export type SortDir = "asc" | "desc";

export interface SortValueContext {
  /** Per-image metadata; undefined until the background read delivers it. */
  meta: ImageMeta | undefined;
  /** Position in the collection as it was delivered — scan order for
   * folders, API rank for sources. */
  sourceIndex: number;
  /** Computed per-image scores (e.g. similarity), keyed by path; empty
   * unless something put scores into the store. */
  scores: Record<string, number>;
}

/** What a sort's value function reads; drives re-sort invalidation. */
export type SortReads = "entry" | "meta" | "scores";

/**
 * One token of a parameterized sort's chip. Every token declares its own
 * interaction: inert words open the sort menu like the rest of the chip,
 * `edit` tokens turn into an inline input in place, `menu` tokens drop
 * their own dropdown (e.g. the model picker).
 */
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

/**
 * A parameterized sort carries transient state (an anchor image, a phrase)
 * and defines its whole lifecycle in one place: how the chip reads and is
 * edited (segments), how the parameter is collected from the sort menu,
 * and how it is dismissed.
 */
export interface SortParam {
  /** The chip as click-target tokens, e.g.
   * `closest to · ["sunset"] · with · [SigLIP 2 Base]`. */
  segments: () => SortChipSegment[];
  /** Menu row shown while the parameter is unset, e.g. `closest to…`.
   * Picking it morphs the sort chip into these segments with the first
   * `edit` token open — collection happens in the chip, nowhere else. */
  collectLabel: string;
  collectHint: string;
  isSet: () => boolean;
  /** Drop the parameter (and with it the sort); rendered as the chip's ×. */
  clear: () => void;
}

export interface SortProvider {
  id: string;
  /** Query-language label, lowercase; the chip reads "sort: {label}". */
  label: string;
  /** Menu hint per direction, e.g. "A→Z" / "Z→A". */
  hints: { asc: string; desc: string };
  /** Direction the first invocation uses; invoking again flips. */
  defaultDir: SortDir;
  /** Scopes where this sort makes sense. */
  appliesTo: (scope: Scope | null) => boolean;
  /** What `value` reads. */
  reads: SortReads;
  /** null for plain sorts (which survive scope changes); parameterized
   * sorts reset with the scope and carry their full lifecycle here. */
  param: SortParam | null;
  /** The sortable value: numbers compare numerically, strings naturally
   * (case-insensitive, numeric-aware); null always sorts last. */
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

/** Test-only: reset global registry state between test cases. */
export function clearSortsForTest(): void {
  registry.clear();
}
