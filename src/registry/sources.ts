import type { FileEntry, ImageMeta } from "../ipc";
import type { Sort } from "../state/query";
import type { Scope } from "../state/store";
import { registerFilterField, type FilterField } from "./filters";
import { registerSort, type SortProvider } from "./sorts";

export interface SourceItem {
  /** `path` is the full-resolution URL — it is the stable key everywhere. */
  entry: FileEntry;
  /** Grid thumbnail URL; the host never generates thumbnails for sources. */
  thumbUrl: string;
  /** Provided whole up front; source entries never get a background metadata read. */
  meta: ImageMeta;
}

export interface ImageSource {
  id: string;
  /** Palette command title, e.g. "Open Reddit Subreddit…". */
  title: string;
  sidebarTitle: string;
  /** Short activity-bar glyph, e.g. "r/". */
  glyph: string;
  /** Hint shown in the palette's argument input. */
  placeholder: string;
  /** Scope-chip value for an argument, e.g. "r/EarthPorn". */
  label: (arg: string) => string;
  fetch: (arg: string) => Promise<SourceItem[]>;
  /** Sorts registered with the source; each declares its own `appliesTo` — nothing is scoped implicitly. */
  sorts: SortProvider[];
  /** Sort a freshly opened collection starts with; null = the usual keep-if-applies rule. */
  defaultSort: Sort | null;
  /** Filter fields registered with the source; scoping as for `sorts`. */
  filters: FilterField[];
}

const registry = new Map<string, ImageSource>();

export function sourceScope(sourceId: string): (scope: Scope | null) => boolean {
  return (scope) => scope?.kind === "source" && scope.sourceId === sourceId;
}

export function registerSource(source: ImageSource): void {
  if (registry.has(source.id)) {
    throw new Error(`source already registered: ${source.id}`);
  }
  registry.set(source.id, source);
  for (const sort of source.sorts) {
    registerSort(sort);
  }
  for (const field of source.filters) {
    registerFilterField(field);
  }
}

export function getSource(id: string): ImageSource | undefined {
  return registry.get(id);
}

export function allSources(): ImageSource[] {
  return [...registry.values()];
}

export function clearSourcesForTest(): void {
  registry.clear();
}
