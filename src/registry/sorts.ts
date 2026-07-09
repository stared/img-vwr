import type { FileEntry, ImageMeta } from "../ipc";
import type { Scope } from "../state/store";

/**
 * Sort registry — every way a collection can be ordered. Sort options are
 * deliberately not hardcoded anywhere: the built-ins (name, modified, size)
 * register here at startup, sources contribute orders that only exist on
 * their collections (Reddit's hot rank, Commons' search relevance), and a
 * future plugin API registers into the same table (e.g. "similar to…" from
 * an embedding model). The sort menu, chip, and palette commands are all
 * derived from this table, filtered by scope.
 */

export type SortDir = "asc" | "desc";

export interface SortValueContext {
  meta: ImageMeta | undefined;
  /** Position in the collection as it was delivered — scan order for
   * folders, API rank for sources. */
  sourceIndex: number;
  /** Computed per-image scores (e.g. similarity), keyed by path. Empty
   * unless something put scores into the store. */
  scores: Record<string, number>;
}

export interface SortProvider {
  id: string;
  /** Query-language label, lowercase; the chip reads "sort: {label}". */
  label: string;
  /** Menu hint per direction, e.g. "A→Z" / "Z→A". */
  hints?: { asc: string; desc: string };
  /** Direction the first invocation uses; invoking again flips. */
  defaultDir: SortDir;
  /** Scopes where this sort makes sense; omit = everywhere. */
  appliesTo?: (scope: Scope | null) => boolean;
  /** True when `value` reads per-image metadata (which streams in late). */
  needsMeta?: boolean;
  /** True when `value` reads computed scores from the store. */
  needsScores?: boolean;
  /** Tied to transient state (an anchor image, a query); reset to the
   * scope default instead of surviving a scope change. */
  transient?: boolean;
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
  return allSorts().filter((p) => p.appliesTo?.(scope) ?? true);
}

/** Test-only: reset global registry state between test cases. */
export function clearSortsForTest(): void {
  registry.clear();
}
