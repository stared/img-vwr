import { useMemo } from "react";
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
import type { FileEntry, ImageMeta, MetaEntry } from "../ipc";
import { newEpoch, scanFolder } from "../ipc";
import type { Query, Sort, SortKey } from "./query";
import {
  applyQuery,
  defaultQuery,
  withFormatToggled,
  withNameFilter,
  withoutFilters,
  withoutFormats,
  withSort,
} from "./query";

export type FolderStatus = "idle" | "loading" | "loaded" | "error";
export type ViewMode = "gallery" | "viewer";

export interface AppState {
  folderPath: string | null;
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
  statsVisible: boolean;
  viewMode: ViewMode;
  /** Index into the VISIBLE (query-applied) list of the selected image. */
  selectedIndex: number;
  /** Filters + sort applied to the scanned folder; survives folder changes. */
  query: Query;
  /** Find-by-name input visibility (the filter bar shows while editing). */
  findOpen: boolean;
  sidebarVisible: boolean;
  paletteOpen: boolean;
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
  openFolder: (path: string) => Promise<void>;
  thumbReady: (path: string, cacheFile: string, epoch: number) => void;
  thumbFailed: (path: string, error: string, epoch: number) => void;
  dirCountReady: (path: string, count: number) => void;
  metaBatchReady: (items: MetaEntry[], epoch: number) => void;
  toggleStats: () => void;
  openViewer: (index: number) => void;
  closeViewer: () => void;
  navigate: (delta: number) => void;
  sortBy: (key: SortKey) => void;
  setSort: (sort: Sort) => void;
  clearFormatFilter: () => void;
  toggleFormatFilter: (group: string) => void;
  setNameFilter: (substring: string) => void;
  clearFilters: () => void;
  setFindOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  viewerImageLoaded: (size: Size) => void;
  viewerWinResized: (size: Size) => void;
  viewerZoom: (factor: number, cursor?: Point) => void;
  viewerPan: (dx: number, dy: number) => void;
  viewerZoomFit: () => void;
  viewerZoomActual: () => void;
}

export const initialState: AppState = {
  folderPath: null,
  entries: [],
  status: "idle",
  error: null,
  epoch: 0,
  thumbs: {},
  thumbErrors: {},
  dirCounts: {},
  meta: {},
  statsVisible: true,
  viewMode: "gallery",
  selectedIndex: 0,
  query: defaultQuery,
  findOpen: false,
  sidebarVisible: true,
  paletteOpen: false,
  viewerView: null,
  viewerImg: null,
  viewerWin: { width: 0, height: 0 },
  viewerFitted: true,
};

/* Pure transitions — actions only apply these. */

export function folderLoading(path: string, epoch: number): Partial<AppState> {
  return {
    folderPath: path,
    entries: [],
    status: "loading",
    error: null,
    epoch,
    thumbs: {},
    thumbErrors: {},
    meta: {},
    viewMode: "gallery",
    selectedIndex: 0,
    viewerView: null,
    viewerImg: null,
  };
}

export function folderLoaded(entries: FileEntry[]): Partial<AppState> {
  return { entries, status: "loaded" };
}

export function folderFailed(message: string): Partial<AppState> {
  return { entries: [], status: "error", error: message };
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
  state: Pick<AppState, "entries" | "query" | "selectedIndex">,
  query: Query,
): Partial<AppState> {
  const selectedPath = applyQuery(state.entries, state.query)[state.selectedIndex]?.path;
  const nextVisible = applyQuery(state.entries, query);
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

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  ...initialState,

  openFolder: async (path) => {
    const epoch = await newEpoch();
    set(folderLoading(path, epoch));
    try {
      const entries = await scanFolder(path);
      // Ignore a stale response if the user already opened another folder.
      if (get().epoch === epoch) {
        set(folderLoaded(entries));
      }
    } catch (error) {
      if (get().epoch === epoch) {
        set(folderFailed(error instanceof Error ? error.message : String(error)));
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
    const next = withMetaBatch(get(), items, epoch);
    if (next) set(next);
  },

  toggleStats: () => set({ statsVisible: !get().statsVisible }),

  openViewer: (index) => {
    const visibleCount = applyQuery(get().entries, get().query).length;
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
    const visibleCount = applyQuery(get().entries, get().query).length;
    set(movedSelection(get(), visibleCount, delta));
  },

  sortBy: (key) => set(withQuery(get(), withSort(get().query, key))),

  setSort: (sort) => set(withQuery(get(), { ...get().query, sort })),

  clearFormatFilter: () => set(withQuery(get(), withoutFormats(get().query))),

  toggleFormatFilter: (group) => set(withQuery(get(), withFormatToggled(get().query, group))),

  setNameFilter: (substring) => set(withQuery(get(), withNameFilter(get().query, substring))),

  clearFilters: () => set({ ...withQuery(get(), withoutFilters(get().query)), findOpen: false }),

  setFindOpen: (open) => set({ findOpen: open }),

  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

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

/** The gallery/viewer's working set: folder entries with filters + sort applied. */
export function useVisibleEntries(): FileEntry[] {
  const entries = useAppStore((s) => s.entries);
  const query = useAppStore((s) => s.query);
  return useMemo(() => applyQuery(entries, query), [entries, query]);
}
