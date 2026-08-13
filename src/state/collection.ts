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
    selectedIndex: null,
    selection: [] as string[],
    selectionAnchor: null,
    // The new folder's stacks are new; a spread left open would be keyed to
    // photographs that no longer exist, and so would a merge-method choice.
    expandedStacks: {} as Record<string, true>,
    hdrMethod: {} as Record<string, import("../ipc").HdrMethod>,
    similarity: null,
    embedProgress: null,
    // People are of the previous folder; a finished detection left standing
    // would auto-cluster the new one and report "no faces" for a folder
    // that was never searched.
    people: null,
    peopleByPath: {} as Record<string, string[]>,
    facesProgress: null,
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

/**
 * Fold a re-read of the open folder into what is already on screen.
 *
 * Not a replacement. The gallery is showing these files right now — one may
 * be selected, several may have thumbnails decoded — and swapping the whole
 * list for a freshly scanned one would throw all of that away every time a
 * file appeared. So entries that are still there keep their identity and
 * their position, new ones are appended, and vanished ones are dropped.
 *
 * Appended rather than sorted in: `entries` is arrival order and the sort
 * lives in the query, so a file landing in the middle of the alphabet still
 * displays in the right place — and everything downstream that walks the
 * list by index (the label loader's cursor, most obviously) stays valid.
 *
 * A file whose size or timestamp moved is a *different* file under the same
 * name — the commonest cause being that the last scan caught it mid-copy.
 * Its cached thumbnail is a picture of a truncated file, so it is dropped
 * along with any error recorded against it, and it is fetched again.
 */
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
  /** Paths whose cached pixels no longer describe the file on disk. */
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

  // Nothing moved: return nothing at all, so no consumer re-renders and no
  // memo is invalidated. A watched folder must cost nothing while it is
  // quiet, and most reports are of a change the app made itself.
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
