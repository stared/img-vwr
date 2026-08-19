import type { FileEntry, ImageMeta } from "../ipc";
import { getSort } from "../registry/sorts";
import { getSource, type SourceItem } from "../registry/sources";
import { defaultQuery, type Sort } from "./query";

export type FolderStatus = "idle" | "loading" | "loaded" | "error";

/** What the gallery is a query over: a local folder or a remote source. */
export type Scope =
  | { kind: "folder"; path: string; recursive: boolean }
  | { kind: "source"; sourceId: string; arg: string; label: string };

/** Sentinel while awaiting the backend's real epoch; backend epochs are positive counters. */
export const EPOCH_PENDING = -1;

interface CollectionTransition {
  entries: FileEntry[];
  status: FolderStatus;
  error: string | null;
}

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
    selectedIndex: null,
    selection: [] as string[],
    selectionAnchor: null,
    expandedStacks: {} as Record<string, true>,
    hdrMethod: {} as Record<string, import("../ipc").HdrMethod>,
    similarity: null,
    embedProgress: null,
    people: null,
    peopleByPath: {} as Record<string, string[]>,
    facesProgress: null,
    viewerView: null,
    viewerImg: null,
  };
}

export function scanBatchArrived(
  state: { entries: FileEntry[] },
  batch: FileEntry[],
  done: boolean,
): Partial<CollectionTransition> {
  const grown = batch.length > 0 ? { entries: [...state.entries, ...batch] } : {};
  return done ? { ...grown, status: "loaded" as const } : grown;
}

/** Merges a rescan: unchanged entries keep identity and position, new ones append (sort lives in the query, index walkers stay valid), size/mtime changes drop the cached thumb. */
export function folderRescanned(
  state: {
    entries: FileEntry[];
    thumbs: Record<string, string>;
    thumbErrors: Record<string, string>;
  },
  scanned: FileEntry[],
): Partial<CollectionTransition & Pick<typeof state, "thumbs" | "thumbErrors">> {
  const found = new Map(scanned.map((e) => [e.path, e]));
  const kept: FileEntry[] = [];
  const drop = new Set<string>();

  for (const existing of state.entries) {
    const now = found.get(existing.path);
    if (!now) {
      drop.add(existing.path);
      continue;
    }
    found.delete(existing.path);
    if (now.size === existing.size && now.modifiedMs === existing.modifiedMs) {
      // Identity preserved on purpose: consumers memoize on it.
      kept.push(existing);
    } else {
      drop.add(existing.path);
      kept.push(now);
    }
  }
  const added = [...found.values()];

  // Returns {} on no change so no consumer re-renders while a watched folder is quiet.
  if (added.length === 0 && drop.size === 0) return {};

  return {
    entries: [...kept, ...added],
    thumbs: without(state.thumbs, drop),
    thumbErrors: without(state.thumbErrors, drop),
  };
}

/** A record with some keys taken out; the same record when none were. */
export function without<T>(record: Record<string, T>, drop: Set<string>): Record<string, T> {
  if (drop.size === 0) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)));
}

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

export function sortForScope(scope: Scope, current: Sort): Sort {
  if (scope.kind === "source") {
    const declared = getSource(scope.sourceId)?.defaultSort;
    if (declared) return declared;
  }
  const provider = getSort(current.key);
  if (provider && provider.param === null && provider.appliesTo(scope)) return current;
  return defaultQuery.sort;
}
