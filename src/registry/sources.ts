import type { FileEntry, ImageMeta } from "../ipc";

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
  /** Hint shown in the palette's argument input. */
  placeholder: string;
  /** Scope-chip value for an argument, e.g. "r/EarthPorn". */
  label: (arg: string) => string;
  fetch: (arg: string) => Promise<SourceItem[]>;
}

const registry = new Map<string, ImageSource>();

export function registerSource(source: ImageSource): void {
  if (registry.has(source.id)) {
    throw new Error(`source already registered: ${source.id}`);
  }
  registry.set(source.id, source);
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
