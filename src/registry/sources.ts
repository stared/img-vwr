import type { FileEntry, ImageMeta } from "../ipc";
import type { Sort } from "../state/query";
import type { Scope } from "../state/store";
import { registerFilterField, type FilterField } from "./filters";
import { registerSort, type SortProvider } from "./sorts";

/**
 * Source registry — where image collections come from. The folder scanner is
 * built in; remote sources (Reddit, Wikimedia Commons, …) register here and
 * get a palette command and scope chip for free. A future plugin API
 * registers into the same table.
 */

export interface SourceItem {
  /** `path` is the full-resolution URL — it is the stable key everywhere. */
  entry: FileEntry;
  /** Grid thumbnail URL; the host never generates thumbnails for sources. */
  thumbUrl: string;
  /** Everything the source API already knows, so stats need no local read. */
  meta: ImageMeta;
}

export interface ImageSource {
  id: string;
  /** Palette command title, e.g. "Open Reddit Subreddit…". */
  title: string;
  /** Sidebar panel title, e.g. "Reddit". */
  sidebarTitle: string;
  /** Short activity-bar glyph, e.g. "r/". */
  glyph: string;
  /** Hint shown in the palette's argument input. */
  placeholder: string;
  /** Scope-chip value for an argument, e.g. "r/EarthPorn". */
  label: (arg: string) => string;
  fetch: (arg: string) => Promise<SourceItem[]>;
  /**
   * Orders that only exist on this source's collections (API rank, search
   * relevance). Registered into the sort registry scoped to this source.
   */
  sorts?: SortProvider[];
  /**
   * Sort a freshly opened collection from this source starts with — the
   * API's own order is usually the point of opening it.
   */
  defaultSort?: Sort;
  /**
   * Filter fields that only exist on this source's collections (e.g. a
   * license on Commons). Registered scoped to this source.
   */
  filters?: FilterField[];
}

const registry = new Map<string, ImageSource>();

export function registerSource(source: ImageSource): void {
  if (registry.has(source.id)) {
    throw new Error(`source already registered: ${source.id}`);
  }
  registry.set(source.id, source);
  const ownScope = (scope: Scope | null) =>
    scope?.kind === "source" && scope.sourceId === source.id;
  for (const sort of source.sorts ?? []) {
    registerSort({ ...sort, appliesTo: sort.appliesTo ?? ownScope });
  }
  for (const field of source.filters ?? []) {
    registerFilterField({ ...field, appliesTo: field.appliesTo ?? ownScope });
  }
}

export function getSource(id: string): ImageSource | undefined {
  return registry.get(id);
}

export function allSources(): ImageSource[] {
  return [...registry.values()];
}

/** Test-only: reset global registry state between test cases. */
export function clearSourcesForTest(): void {
  registry.clear();
}
