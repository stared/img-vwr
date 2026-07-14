import { create } from "zustand";

import type { Size, Viewport } from "../components/viewer/viewport";
import {
  actualSize,
  clampPan,
  fitToWindow,
  panBy,
  zoomAtPoint,
  type Point,
} from "../components/viewer/viewport";
import type { EmbedModelInfo, FileEntry, ImageLabels, ImageMeta, MetaEntry } from "../ipc";
import { newEpoch, scanFolder } from "../ipc";
import { getSort } from "../registry/sorts";
import { getSource, type SourceItem } from "../registry/sources";
import type { Query, Sort } from "./query";
import {
  applyQuery,
  defaultQuery,
  usesLabels,
  usesMeta,
  usesScores,
  withFormatToggled,
  withNameFilter,
  withoutFilters,
  withoutFormats,
  withRangeSet,
  withRangeToggled,
  withSelectSet,
  withSelectToggled,
  withSort,
} from "./query";

export type FolderStatus = "idle" | "loading" | "loaded" | "error";
export type ViewMode = "gallery" | "viewer";
export type GalleryLayout = "grid" | "map";

/** What the gallery is a query over: a local folder or a remote source. */
export type Scope =
  | { kind: "folder"; path: string; recursive: boolean }
  | { kind: "source"; sourceId: string; arg: string; label: string };

/** Computed per-image scores backing a transient sort ("similar to …"). */
export interface Similarity {
  /** Chip value describing the anchor: a file name or a quoted phrase. */
  label: string;
  /** What the scores measure distance to; kept for re-ranking as the
   * background index fills in. */
  anchor: { kind: "image"; path: string } | { kind: "text"; query: string };
  scores: Record<string, number>;
}

/** Embedding model lifecycle, mirrored from Rust events for the panel. */
export interface EmbedStatus {
  modelId: string;
  phase: "downloading" | "loading" | "ready" | "error";
  error: string | null;
}

export interface AppState {
  scope: Scope | null;
  entries: FileEntry[];
  status: FolderStatus;
  error: string | null;
  /** Folder generation; thumbnail events from older epochs are ignored. */
  epoch: number;
  /** path → absolute cache-file path, filled as thumbnail events stream in. */
  thumbs: Record<string, string>;
  /** path → error message for thumbnails that failed to generate. */
  thumbErrors: Record<string, string>;
  /** folder path → direct image count, streamed from background counting. */
  dirCounts: Record<string, number>;
  /** path → per-image metadata, streamed in batches for the stats panel. */
  meta: Record<string, ImageMeta>;
  /** path → user labels (stars, tags), loaded per scope from the app-local
   * label store; absent = unlabeled. */
  labels: Record<string, ImageLabels>;
  statsVisible: boolean;
  viewMode: ViewMode;
  /** How the gallery renders the visible entries; map plots geolocated ones. */
  galleryLayout: GalleryLayout;
  /** Index into the VISIBLE (query-applied) list of the selected image. */
  selectedIndex: number;
  /** Filters + sort applied to the scanned folder; survives folder changes. */
  query: Query;
  /** Find-by-name input visibility (the filter bar shows while editing). */
  findOpen: boolean;
  sidebarVisible: boolean;
  /** Which left panel the activity bar has selected (one at a time). */
  activePanelId: string;
  paletteOpen: boolean;
  /** Command id the palette should open in argument-collect mode for. */
  palettePrompt: string | null;
  /** Right-click menu position over the selected image; null = closed. */
  imageMenu: { x: number; y: number } | null;
  /** Scores + label behind the "similar" sort; null = no anchor chosen. */
  similarity: Similarity | null;
  /** Model catalog with downloaded/active flags, for the picker panel. */
  embedModels: EmbedModelInfo[];
  /** Latest model lifecycle event; null before any selection. */
  embedStatus: EmbedStatus | null;
  /** Indexing progress of the current collection; null when idle. */
  embedProgress: { done: number; total: number } | null;
  /** Viewer transform; null until the current image has loaded. */
  viewerView: Viewport | null;
  /** Natural size of the loaded viewer image. */
  viewerImg: Size | null;
  /** Size of the viewer canvas element. */
  viewerWin: Size;
  /** True while the view still tracks fit-to-window (resets on manual zoom/pan). */
  viewerFitted: boolean;
}

interface AppActions {
  openFolder: (path: string, recursive: boolean) => Promise<void>;
  openSource: (sourceId: string, arg: string) => Promise<void>;
  /** A streamed slice of the running scan (epoch-guarded, like thumbs). */
  scanBatch: (entries: FileEntry[], epoch: number, done: boolean) => void;
  thumbReady: (path: string, cacheFile: string, epoch: number) => void;
  thumbFailed: (path: string, error: string, epoch: number) => void;
  dirCountReady: (path: string, count: number) => void;
  metaBatchReady: (items: MetaEntry[], epoch: number) => void;
  /** Install the scope's stored labels (epoch-guarded, like meta). */
  labelsLoaded: (labels: Record<string, ImageLabels>, epoch: number) => void;
  /** One image's labels changed (rate/tag); mirror the store's response. */
  labelApplied: (path: string, labels: ImageLabels) => void;
  toggleStats: () => void;
  setGalleryLayout: (layout: GalleryLayout) => void;
  openViewer: (index: number) => void;
  closeViewer: () => void;
  navigate: (delta: number) => void;
  sortBy: (key: string) => void;
  setSort: (sort: Sort) => void;
  clearFormatFilter: () => void;
  toggleFormatFilter: (group: string) => void;
  toggleSelectFilter: (field: string, value: string) => void;
  toggleRangeFilter: (field: string, from: number, to: number, label: string) => void;
  setSelectFilter: (field: string, value: string) => void;
  setRangeFilter: (field: string, from: number, to: number, label: string) => void;
  setNameFilter: (substring: string) => void;
  clearFilters: () => void;
  setFindOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** VS Code semantics: re-selecting the active icon collapses the sidebar. */
  setActivePanel: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  /** Open the palette directly in a command's argument input. */
  promptCommand: (commandId: string) => void;
  setImageMenu: (pos: { x: number; y: number } | null) => void;
  /** Install similarity scores and switch the sort to "similar". */
  setSimilarity: (similarity: Similarity) => void;
  clearSimilarity: () => void;
  setEmbedModels: (models: EmbedModelInfo[]) => void;
  setEmbedStatus: (status: EmbedStatus) => void;
  setEmbedProgress: (progress: { done: number; total: number } | null) => void;
  viewerImageLoaded: (size: Size) => void;
  viewerWinResized: (size: Size) => void;
  viewerZoom: (factor: number, cursor?: Point) => void;
  viewerPan: (dx: number, dy: number) => void;
  viewerZoomFit: () => void;
  viewerZoomActual: () => void;
}

export const initialState: AppState = {
  scope: null,
  entries: [],
  status: "idle",
  error: null,
  epoch: 0,
  thumbs: {},
  thumbErrors: {},
  dirCounts: {},
  meta: {},
  labels: {},
  statsVisible: true,
  viewMode: "gallery",
  galleryLayout: "grid",
  selectedIndex: 0,
  query: defaultQuery,
  findOpen: false,
  sidebarVisible: true,
  activePanelId: "folders",
  paletteOpen: false,
  palettePrompt: null,
  imageMenu: null,
  similarity: null,
  embedModels: [],
  embedStatus: null,
  embedProgress: null,
  viewerView: null,
  viewerImg: null,
  viewerWin: { width: 0, height: 0 },
  viewerFitted: true,
};

/* Pure transitions — actions only apply these. */

export function scopeLoading(scope: Scope, epoch: number): Partial<AppState> {
  return {
    scope,
    entries: [],
    status: "loading",
    error: null,
    epoch,
    thumbs: {},
    thumbErrors: {},
    meta: {},
    labels: {},
    viewMode: "gallery",
    selectedIndex: 0,
    // Similarity anchors are per-collection; a new scope starts without one.
    similarity: null,
    embedProgress: null,
    viewerView: null,
    viewerImg: null,
  };
}

/**
 * Append a streamed scan batch; the final one flips the status. Entries
 * arrive in walk order — display order is the query's sort, applied in
 * useVisibleEntries, so no order is kept here.
 */
export function scanBatchArrived(
  state: Pick<AppState, "entries">,
  batch: FileEntry[],
  done: boolean,
): Partial<AppState> {
  const grown = batch.length > 0 ? { entries: [...state.entries, ...batch] } : {};
  return done ? { ...grown, status: "loaded" } : grown;
}

/**
 * A remote source arrives with thumbnails and metadata already known —
 * prefilling them means the background Rust readers have nothing to do.
 */
export function sourceLoaded(items: SourceItem[]): Partial<AppState> {
  const thumbs: Record<string, string> = {};
  const meta: Record<string, ImageMeta> = {};
  for (const item of items) {
    thumbs[item.entry.path] = item.thumbUrl;
    meta[item.entry.path] = item.meta;
  }
  return { entries: items.map((i) => i.entry), thumbs, meta, status: "loaded" };
}

export function scopeFailed(message: string): Partial<AppState> {
  return { entries: [], status: "error", error: message };
}

/**
 * Sort for a freshly opened scope. A source's declared default wins — its
 * API order (hot rank, relevance) is usually why you opened it. Otherwise
 * the current sort survives wherever it still applies (folder → folder
 * keeps your choice), and falls back to the app default when it doesn't
 * (e.g. "hot" makes no sense on a local folder).
 */
export function sortForScope(scope: Scope, current: Sort): Sort {
  if (scope.kind === "source") {
    const declared = getSource(scope.sourceId)?.defaultSort;
    if (declared) return declared;
  }
  const provider = getSort(current.key);
  // Parameterized sorts (similarity) lose their anchor with the scope.
  if (provider && provider.param === null && provider.appliesTo(scope)) return current;
  return defaultQuery.sort;
}

/** Move the selection by `delta` within `count` items; a real move resets the viewport. */
export function movedSelection(
  state: Pick<AppState, "selectedIndex">,
  count: number,
  delta: number,
): Partial<AppState> {
  if (count === 0) return {};
  const index = Math.min(count - 1, Math.max(0, state.selectedIndex + delta));
  if (index === state.selectedIndex) return {};
  return { selectedIndex: index, viewerView: null, viewerImg: null, viewerFitted: true };
}

/**
 * Change the query while keeping the same image selected if it survives the
 * new filters; otherwise fall back to the top.
 */
export function withQuery(
  state: Pick<AppState, "entries" | "query" | "selectedIndex" | "meta" | "similarity" | "labels">,
  query: Query,
): Partial<AppState> {
  const selectedPath = visibleOf(state, state.query)[state.selectedIndex]?.path;
  const nextVisible = visibleOf(state, query);
  const index = selectedPath ? nextVisible.findIndex((e) => e.path === selectedPath) : -1;
  return { query, selectedIndex: index >= 0 ? index : 0 };
}

export function withThumb(
  state: Pick<AppState, "thumbs" | "epoch">,
  path: string,
  cacheFile: string,
  epoch: number,
): Partial<AppState> | null {
  if (epoch !== state.epoch) return null;
  return { thumbs: { ...state.thumbs, [path]: cacheFile } };
}

export function withThumbError(
  state: Pick<AppState, "thumbErrors" | "epoch">,
  path: string,
  error: string,
  epoch: number,
): Partial<AppState> | null {
  if (epoch !== state.epoch) return null;
  return { thumbErrors: { ...state.thumbErrors, [path]: error } };
}

export function withMetaBatch(
  state: Pick<AppState, "meta" | "epoch">,
  items: MetaEntry[],
  epoch: number,
): Partial<AppState> | null {
  if (epoch !== state.epoch || items.length === 0) return null;
  const meta = { ...state.meta };
  for (const item of items) {
    meta[item.path] = item.meta;
  }
  return { meta };
}

type ViewerState = Pick<AppState, "viewerView" | "viewerImg" | "viewerWin">;

export function zoomedBy(state: ViewerState, factor: number, cursor?: Point): Partial<AppState> {
  const { viewerView, viewerImg, viewerWin } = state;
  if (!viewerView || !viewerImg) return {};
  const at = cursor ?? { x: viewerWin.width / 2, y: viewerWin.height / 2 };
  return {
    viewerView: clampPan(zoomAtPoint(viewerView, at, factor), viewerImg, viewerWin),
    viewerFitted: false,
  };
}

export function pannedBy(state: ViewerState, dx: number, dy: number): Partial<AppState> {
  const { viewerView, viewerImg, viewerWin } = state;
  if (!viewerView || !viewerImg) return {};
  return {
    viewerView: clampPan(panBy(viewerView, dx, dy), viewerImg, viewerWin),
    viewerFitted: false,
  };
}

/* Scan batches can arrive faster than a huge collection re-sorts; the store
 * coalesces them so the visible list refreshes a few times per second, not
 * once per event. The first slice flushes immediately for a fast first
 * paint; the final one flushes immediately to finish the scan. */
const SCAN_FLUSH_MS = 250;
let scanBuffer: { epoch: number; entries: FileEntry[]; done: boolean } | null = null;
let scanFlushTimer: ReturnType<typeof setTimeout> | null = null;

/* Metadata batches get the same treatment: the background EXIF pass over a
 * big folder emits hundreds of small batches, and consumers (stats panel)
 * recompute over the whole collection per update. */
const META_FLUSH_MS = 400;
let metaBuffer: { epoch: number; items: MetaEntry[] } | null = null;
let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  ...initialState,

  openFolder: async (path, recursive) => {
    const epoch = await newEpoch();
    const scope: Scope = { kind: "folder", path, recursive };
    const query = get().query;
    set({
      ...scopeLoading(scope, epoch),
      query: { ...query, sort: sortForScope(scope, query.sort) },
    });
    try {
      // Entries stream in as scanBatch events; this only starts the walk.
      await scanFolder(path, recursive, epoch);
    } catch (error) {
      // Ignore a stale failure if the user already opened another scope.
      if (get().epoch === epoch) {
        set(scopeFailed(error instanceof Error ? error.message : String(error)));
      }
    }
  },

  scanBatch: (entries, epoch, done) => {
    if (epoch !== get().epoch) return;
    if (scanBuffer === null || scanBuffer.epoch !== epoch) {
      scanBuffer = { epoch, entries: [], done: false };
    }
    scanBuffer.entries.push(...entries);
    scanBuffer.done ||= done;
    const flush = () => {
      scanFlushTimer = null;
      const buffered = scanBuffer;
      scanBuffer = null;
      if (buffered && buffered.epoch === get().epoch) {
        set(scanBatchArrived(get(), buffered.entries, buffered.done));
      }
    };
    if (done || get().entries.length === 0) {
      if (scanFlushTimer !== null) clearTimeout(scanFlushTimer);
      flush();
    } else if (scanFlushTimer === null) {
      scanFlushTimer = setTimeout(flush, SCAN_FLUSH_MS);
    }
  },

  openSource: async (sourceId, arg) => {
    const source = getSource(sourceId);
    if (!source) return;
    const epoch = await newEpoch();
    const scope: Scope = { kind: "source", sourceId, arg, label: source.label(arg) };
    const query = get().query;
    set({
      ...scopeLoading(scope, epoch),
      query: { ...query, sort: sortForScope(scope, query.sort) },
    });
    try {
      const items = await source.fetch(arg);
      if (get().epoch === epoch) {
        set(sourceLoaded(items));
      }
    } catch (error) {
      if (get().epoch === epoch) {
        set(scopeFailed(error instanceof Error ? error.message : String(error)));
      }
    }
  },

  thumbReady: (path, cacheFile, epoch) => {
    const next = withThumb(get(), path, cacheFile, epoch);
    if (next) set(next);
  },

  thumbFailed: (path, error, epoch) => {
    const next = withThumbError(get(), path, error, epoch);
    if (next) set(next);
  },

  // Counts are keyed by absolute path, so they can't go stale — no epoch guard.
  dirCountReady: (path, count) => set({ dirCounts: { ...get().dirCounts, [path]: count } }),

  metaBatchReady: (items, epoch) => {
    if (epoch !== get().epoch) return;
    if (metaBuffer === null || metaBuffer.epoch !== epoch) {
      metaBuffer = { epoch, items: [] };
    }
    metaBuffer.items.push(...items);
    if (metaFlushTimer === null) {
      metaFlushTimer = setTimeout(() => {
        metaFlushTimer = null;
        const buffered = metaBuffer;
        metaBuffer = null;
        if (buffered) {
          const next = withMetaBatch(get(), buffered.items, buffered.epoch);
          if (next) set(next);
        }
      }, META_FLUSH_MS);
    }
  },

  // Merge, not replace: batches of a streaming scan each bring their slice.
  labelsLoaded: (labels, epoch) => {
    if (epoch === get().epoch) set({ labels: { ...get().labels, ...labels } });
  },

  labelApplied: (path, labels) => set({ labels: { ...get().labels, [path]: labels } }),

  toggleStats: () => set({ statsVisible: !get().statsVisible }),

  setGalleryLayout: (layout) => set({ galleryLayout: layout }),

  openViewer: (index) => {
    const visibleCount = visibleOf(get(), get().query).length;
    if (index >= 0 && index < visibleCount) {
      set({
        viewMode: "viewer",
        selectedIndex: index,
        viewerView: null,
        viewerImg: null,
        viewerFitted: true,
      });
    }
  },

  closeViewer: () => set({ viewMode: "gallery" }),

  navigate: (delta) => {
    const visibleCount = visibleOf(get(), get().query).length;
    set(movedSelection(get(), visibleCount, delta));
  },

  sortBy: (key) => set(withQuery(get(), withSort(get().query, key))),

  setSort: (sort) => set(withQuery(get(), { ...get().query, sort })),

  clearFormatFilter: () => set(withQuery(get(), withoutFormats(get().query))),

  toggleFormatFilter: (group) => set(withQuery(get(), withFormatToggled(get().query, group))),

  toggleSelectFilter: (field, value) =>
    set(withQuery(get(), withSelectToggled(get().query, field, value))),

  toggleRangeFilter: (field, from, to, label) =>
    set(withQuery(get(), withRangeToggled(get().query, field, from, to, label))),

  setSelectFilter: (field, value) => set(withQuery(get(), withSelectSet(get().query, field, value))),

  setRangeFilter: (field, from, to, label) =>
    set(withQuery(get(), withRangeSet(get().query, field, from, to, label))),

  setNameFilter: (substring) => set(withQuery(get(), withNameFilter(get().query, substring))),

  clearFilters: () => set({ ...withQuery(get(), withoutFilters(get().query)), findOpen: false }),

  setFindOpen: (open) => set({ findOpen: open }),

  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),

  setActivePanel: (id) => {
    const { activePanelId, sidebarVisible } = get();
    if (id === activePanelId && sidebarVisible) {
      set({ sidebarVisible: false });
    } else {
      set({ activePanelId: id, sidebarVisible: true });
    }
  },

  setPaletteOpen: (open) => set({ paletteOpen: open, palettePrompt: null }),

  promptCommand: (commandId) => set({ paletteOpen: true, palettePrompt: commandId }),

  setImageMenu: (imageMenu) => set({ imageMenu }),

  setSimilarity: (similarity) => {
    // Streaming score updates must not reset a direction the user flipped.
    const current = get().query.sort;
    const dir = current.key === "similar" ? current.dir : "desc";
    set({
      similarity,
      ...withQuery({ ...get(), similarity }, { ...get().query, sort: { key: "similar", dir } }),
    });
  },

  clearSimilarity: () => {
    const { query } = get();
    const sort = query.sort.key === "similar" ? defaultQuery.sort : query.sort;
    set({ similarity: null, ...withQuery({ ...get(), similarity: null }, { ...query, sort }) });
  },

  setEmbedModels: (embedModels) => set({ embedModels }),

  setEmbedStatus: (embedStatus) => set({ embedStatus }),

  setEmbedProgress: (embedProgress) => set({ embedProgress }),

  viewerImageLoaded: (size) =>
    set({
      viewerImg: size,
      viewerView: fitToWindow(size, get().viewerWin),
      viewerFitted: true,
    }),

  viewerWinResized: (size) => {
    const { viewerFitted, viewerImg } = get();
    set({ viewerWin: size });
    if (viewerFitted && viewerImg) {
      set({ viewerView: fitToWindow(viewerImg, size) });
    }
  },

  viewerZoom: (factor, cursor) => set(zoomedBy(get(), factor, cursor)),

  viewerPan: (dx, dy) => set(pannedBy(get(), dx, dy)),

  viewerZoomFit: () => {
    const { viewerImg, viewerWin } = get();
    if (viewerImg) set({ viewerView: fitToWindow(viewerImg, viewerWin), viewerFitted: true });
  },

  viewerZoomActual: () => {
    const { viewerImg, viewerWin } = get();
    if (viewerImg) set({ viewerView: actualSize(viewerImg, viewerWin), viewerFitted: false });
  },
}));

/* The query-applied view is needed by half a dozen components and several
 * actions at once; on tens of thousands of entries each application is a
 * full filter + sort, so all consumers share one memoized result. The memo
 * holds the last inputs by identity — one slot is enough, since every
 * consumer reads the same store state. */
let visibleCache: {
  entries: FileEntry[];
  query: Query;
  meta: Record<string, ImageMeta> | null;
  scores: Record<string, number> | null;
  labels: Record<string, ImageLabels> | null;
  result: FileEntry[];
} | null = null;

/** Entries with filters + sort applied, memoized across all callers. */
export function visibleOf(
  state: Pick<AppState, "entries" | "meta" | "similarity" | "labels">,
  query: Query,
): FileEntry[] {
  // Only the channels the query reads participate — streaming meta/label
  // batches must not re-sort thousands of entries a plain name sort ignores.
  const meta = usesMeta(query) ? state.meta : null;
  const scores = usesScores(query) ? (state.similarity?.scores ?? null) : null;
  const labels = usesLabels(query) ? state.labels : null;
  return applyQueryMemo(state.entries, query, meta, scores, labels);
}

function applyQueryMemo(
  entries: FileEntry[],
  query: Query,
  meta: Record<string, ImageMeta> | null,
  scores: Record<string, number> | null,
  labels: Record<string, ImageLabels> | null,
): FileEntry[] {
  const c = visibleCache;
  if (
    c &&
    c.entries === entries &&
    c.query === query &&
    c.meta === meta &&
    c.scores === scores &&
    c.labels === labels
  ) {
    return c.result;
  }
  const result = applyQuery(entries, query, {
    meta: meta ?? {},
    scores: scores ?? {},
    labels: labels ?? {},
  });
  visibleCache = { entries, query, meta, scores, labels, result };
  return result;
}

/** The gallery/viewer's working set: folder entries with filters + sort applied. */
export function useVisibleEntries(): FileEntry[] {
  const entries = useAppStore((s) => s.entries);
  const query = useAppStore((s) => s.query);
  // Subscribe to a data channel only while the query reads it — otherwise
  // every streamed meta/label batch re-renders every consumer for nothing.
  const meta = useAppStore((s) => (usesMeta(s.query) ? s.meta : null));
  const scores = useAppStore((s) => (usesScores(s.query) ? (s.similarity?.scores ?? null) : null));
  const labels = useAppStore((s) => (usesLabels(s.query) ? s.labels : null));
  return applyQueryMemo(entries, query, meta, scores, labels);
}
