import type { FileEntry, ImageMeta } from "../ipc";
import { getSort } from "../registry/sorts";
import { getSource, type SourceItem } from "../registry/sources";
import { defaultQuery, type Sort } from "./query";

export type FolderStatus = "idle" | "loading" | "loaded" | "error";

/** What the gallery is a query over: a local folder or a remote source. */
export type Scope =
  | { kind: "folder"; path: string; recursive: boolean }
  | { kind: "source"; sourceId: string; arg: string; label: string };

/**
 * Epoch of a scope that flipped optimistically and is still waiting for its
 * real epoch from the backend. Backend epochs are positive counters.
 */
export const EPOCH_PENDING = -1;

interface CollectionTransition {
  entries: FileEntry[];
  status: FolderStatus;
  error: string | null;
}

/** State reset shared by local folders and remote sources. */
export function scopeLoading(scope: Scope, epoch: number) {
  return {
    scope,
    entries: [] as FileEntry[],
    status: "loading" as const,
    error: null,
    epoch,
    thumbs: {} as Record<string, string>,
    thumbErrors: {} as Record<string, string>,
    meta: {} as Record<string, ImageMeta>,
    labels: {},
    viewMode: "gallery" as const,
    selectedIndex: 0,
    similarity: null,
    embedProgress: null,
    viewerView: null,
    viewerImg: null,
  };
}

/** Append one streamed scan slice and complete the collection on the final slice. */
export function scanBatchArrived(
  state: { entries: FileEntry[] },
  batch: FileEntry[],
  done: boolean,
): Partial<CollectionTransition> {
  const grown = batch.length > 0 ? { entries: [...state.entries, ...batch] } : {};
  return done ? { ...grown, status: "loaded" as const } : grown;
}

/** Install a remote source whose thumbnails and metadata are already known. */
export function sourceLoaded(items: SourceItem[]) {
  const thumbs: Record<string, string> = {};
  const meta: Record<string, ImageMeta> = {};
  for (const item of items) {
    thumbs[item.entry.path] = item.thumbUrl;
    meta[item.entry.path] = item.meta;
  }
  return { entries: items.map((i) => i.entry), thumbs, meta, status: "loaded" as const };
}

export function scopeFailed(message: string): Partial<CollectionTransition> {
  return { entries: [] as FileEntry[], status: "error" as const, error: message };
}

/** Choose a valid initial sort when changing collection scope. */
export function sortForScope(scope: Scope, current: Sort): Sort {
  if (scope.kind === "source") {
    const declared = getSource(scope.sourceId)?.defaultSort;
    if (declared) return declared;
  }
  const provider = getSort(current.key);
  if (provider && provider.param === null && provider.appliesTo(scope)) return current;
  return defaultQuery.sort;
}
