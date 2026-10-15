import { create } from "zustand";

import type { Size, Viewport } from "../components/viewer/viewport";
import {
  actualSize,
  clampPan,
  fitToWindow,
  heldView,
  panBy,
  zoomAtPoint,
  type Point,
} from "../components/viewer/viewport";
import type {
  Crop,
  FileEntry,
  ImageMeta,
  MetaEntry,
} from "../ipc";
import { api } from "../ipc";
import { storeChannel, type Channel } from "../registry/channels";
import { getSource } from "../registry/sources";
import {
  EPOCH_PENDING,
  folderRescanned,
  scanBatchArrived,
  scopeFailed,
  scopeLoading,
  sortForScope,
  sourceLoaded,
  type FolderStatus,
  type Scope,
} from "./collection";
import { DEFAULT_OPTIONS, type ExportOptions } from "./export";
import type { Query, Sort } from "./query";
import { stackKeyOf, type StackLead } from "./stacks";
import {
  movedSelection,
  withDeleted,
  withQuery,
  withSelection,
  withSelectionAt,
  withSelectionHeld,
  type SelectMode,
} from "./selection";
import { visibleOf } from "./visible";
import {
  defaultQuery,
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

export type ViewMode = "gallery" | "viewer";
/** A registered view's id. */
export type GalleryLayout = string;


export type { FolderStatus, Scope } from "./collection";
export { scanBatchArrived, sortForScope } from "./collection";

export interface AppState {
  scope: Scope | null;
  entries: FileEntry[];
  status: FolderStatus;
  error: string | null;
  /** Folder generation; thumbnail events from older epochs are ignored. */
  epoch: number;
  /** path → absolute cache-file path, filled as thumbnail events stream in. */
  thumbs: Record<string, string>;
  thumbErrors: Record<string, string>;
  /** folder path → direct image count, streamed from background counting. */
  dirCounts: Record<string, number>;
  meta: Record<string, ImageMeta>;
  /** path → stored develop crop, for miniatures; absent = whole frame. */
  crops: Record<string, Crop>;
  inspectorVisible: boolean;
  /** Sidebar sections folded away, by panel id; absent = open. Persisted. */
  panelFolds: Record<string, boolean>;
  /** Right-column section order, panel ids; unknown ids keep registration order after these. Persisted. */
  panelOrder: string[];
  pinnedPanels: string[];
  /** Every folder opened, most recent first. */
  recentFolders: string[];
  /** Kept in this order until unpinned, unlike recentFolders. */
  pinnedFolders: string[];
  /** Sidebar widths, px — dragged at the inner edge. Persisted. */
  sidebarWidth: number;
  rightbarWidth: number;
  viewMode: ViewMode;
  galleryLayout: GalleryLayout;
  gridColumns: number;
  /** Moves the lead one visual row (+1 down, -1 up); registered by the mounted view, which alone knows its geometry; null when it has no second dimension. */
  rowNavigator: ((direction: 1 | -1) => void) | null;
  /** Collapse raw+JPEG pairs into one photograph — only where one is on screen at a time; see `stacksCollapse`. */
  stacking: boolean;
  stackLead: StackLead;
  /** stack key → the member the user chose to show; absent means `stackLead` decides. */
  preferredMember: Record<string, string>;
  /** Photograph keys spread open in the filmstrip; strip-only — the visible list stays collapsed, one photograph one index. */
  expandedStacks: Record<string, true>;
  /** Index into the visible (query-applied) list of the lead photograph — the one panels describe; null when nothing is selected. */
  selectedIndex: number | null;
  /** Selected paths in on-screen order; empty exactly when `selectedIndex` is null, and always contains the lead. */
  selection: string[];
  /** The photograph a ⇧-click extends from: the last one clicked on its own. */
  selectionAnchor: string | null;
  /** Filters + sort applied to the scanned folder; survives folder changes. */
  query: Query;
  findOpen: boolean;
  sidebarVisible: boolean;
  activePanelId: string;
  paletteOpen: boolean;
  /** Command id the palette should open in argument-collect mode for. */
  palettePrompt: string | null;
  shortcutsOpen: boolean;
  /** The export sheet is up; it reads the selection when it opens and holds it. */
  exportOpen: boolean;
  /** Kept between openings; session state, not a stored preference. */
  exportOptions: ExportOptions;
  exportFolder: string | null;
  /** Right-click menu position over the selected image; null = closed. */
  imageMenu: { x: number; y: number } | null;
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
  /** The open folder, re-read after something changed on disk. */
  folderChanged: (entries: FileEntry[], epoch: number) => void;
  thumbReady: (path: string, cacheFile: string, epoch: number) => void;
  thumbFailed: (path: string, error: string, epoch: number) => void;
  dirCountReady: (path: string, count: number) => void;
  metaBatchReady: (items: MetaEntry[], epoch: number) => void;
  /** Install stored crops for a scope's paths (epoch-guarded, like meta). */
  cropsLoaded: (crops: Record<string, Crop>, epoch: number) => void;
  /** One photograph's crop changed in the darkroom; null = back to whole. */
  cropApplied: (path: string, crop: Crop | null) => void;
  toggleInspector: () => void;
  togglePanelFold: (id: string) => void;
  togglePanelPin: (id: string) => void;
  toggleFolderPin: (path: string) => void;
  setPanelOrder: (order: string[]) => void;
  setSidebarWidth: (px: number) => void;
  setRightbarWidth: (px: number) => void;
  setGalleryLayout: (layout: GalleryLayout) => void;
  setGridColumns: (columns: number) => void;
  setRowNavigator: (navigator: ((direction: 1 | -1) => void) | null) => void;
  /** Fresh banded similarities for exactly this visible list. */
  toggleStacking: () => void;
  toggleStackLead: () => void;
  /** Show `path` in place of whatever its stack was showing. */
  preferMember: (path: string) => void;
  toggleStackExpanded: (key: string) => void;
  /** Select one image, or nothing (null) — clicking empty space, or Esc. */
  select: (index: number | null) => void;
  /** Click on an image with modifiers held; see `selectMode`. */
  selectAt: (index: number, mode: SelectMode) => void;
  selectAll: () => void;
  /** Right-click: inside the selection acts on the whole of it, outside replaces it. */
  selectForMenu: (index: number) => void;
  /** Files that are gone from disk, taken out of the collection. */
  deleted: (paths: string[]) => void;
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
  /** Re-selecting the active icon collapses the sidebar. */
  setActivePanel: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setExportOptions: (options: ExportOptions) => void;
  setExportFolder: (folder: string) => void;
  /** Open the palette directly in a command's argument input. */
  promptCommand: (commandId: string) => void;
  setImageMenu: (pos: { x: number; y: number } | null) => void;
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
  crops: {},
  inspectorVisible: true,
  panelFolds: {},
  panelOrder: [],
  pinnedPanels: [],
  recentFolders: [],
  pinnedFolders: [],
  sidebarWidth: 230,
  // Wide enough for the Shot block's one-line exposure row at worst case (five-digit ISO, negative EV).
  rightbarWidth: 310,
  viewMode: "gallery",
  galleryLayout: "grid",
  gridColumns: 6,
  rowNavigator: null,
  // On by default: a raw+JPEG folder otherwise shows every photograph twice.
  stacking: true,
  stackLead: "jpg",
  preferredMember: {},
  expandedStacks: {},
  selectedIndex: null,
  selection: [],
  selectionAnchor: null,
  query: defaultQuery,
  findOpen: false,
  sidebarVisible: true,
  activePanelId: "folders",
  paletteOpen: false,
  shortcutsOpen: false,
  palettePrompt: null,
  exportOpen: false,
  exportOptions: DEFAULT_OPTIONS,
  exportFolder: null,
  imageMenu: null,
  viewerView: null,
  viewerImg: null,
  viewerWin: { width: 0, height: 0 },
  viewerFitted: true,
};

function withThumb(
  state: Pick<AppState, "thumbs" | "epoch">,
  path: string,
  cacheFile: string,
  epoch: number,
): Partial<AppState> | null {
  if (epoch !== state.epoch) return null;
  return { thumbs: { ...state.thumbs, [path]: cacheFile } };
}

function withThumbError(
  state: Pick<AppState, "thumbErrors" | "epoch">,
  path: string,
  error: string,
  epoch: number,
): Partial<AppState> | null {
  if (epoch !== state.epoch) return null;
  return { thumbErrors: { ...state.thumbErrors, [path]: error } };
}

function withMetaBatch(
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

function zoomedBy(state: ViewerState, factor: number, cursor?: Point): Partial<AppState> {
  const { viewerView, viewerImg, viewerWin } = state;
  if (!viewerView || !viewerImg) return {};
  const at = cursor ?? { x: viewerWin.width / 2, y: viewerWin.height / 2 };
  return {
    viewerView: clampPan(zoomAtPoint(viewerView, at, factor), viewerImg, viewerWin),
    viewerFitted: false,
  };
}

function pannedBy(state: ViewerState, dx: number, dy: number): Partial<AppState> {
  const { viewerView, viewerImg, viewerWin } = state;
  if (!viewerView || !viewerImg) return {};
  return {
    viewerView: clampPan(panBy(viewerView, dx, dy), viewerImg, viewerWin),
    viewerFitted: false,
  };
}

/* Scan batches arrive faster than a huge collection re-sorts; coalesced so the visible list refreshes a few times per second. First and final slices flush immediately. */
const SCAN_FLUSH_MS = 250;
const RECENT_FOLDERS = 8;

function withRecent(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_FOLDERS);
}
let scanBuffer: { epoch: number; entries: FileEntry[]; done: boolean } | null = null;
let scanFlushTimer: ReturnType<typeof setTimeout> | null = null;

/* Metadata batches get the same treatment: consumers recompute over the whole collection per update. */
const META_FLUSH_MS = 400;
let metaBuffer: { epoch: number; items: MetaEntry[] } | null = null;
let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  ...initialState,

  openFolder: async (path, recursive) => {
    const scope: Scope = { kind: "folder", path, recursive };
    const query = get().query;
    // The UI flips before ANY round-trip: a click must never wait on IPC.
    set({
      ...scopeLoading(scope, EPOCH_PENDING),
      query: { ...query, sort: sortForScope(scope, query.sort) },
      recentFolders: withRecent(get().recentFolders, path),
    });
    const epoch = await api.newEpoch();
    // Another scope was opened while the epoch was being fetched.
    if (get().scope !== scope) return;
    set({ epoch });
    try {
      // Entries stream in as scanBatch events; only the error branch matters here.
      await api.scanFolder(path, recursive, epoch);
    } catch (error) {
      // Ignore a stale failure if the user already opened another scope.
      if (get().scope === scope) {
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

  // Held, because the list changes under an index selection; ignored while the first scan streams — the two would fight over `entries`.
  folderChanged: (entries, epoch) => {
    if (epoch !== get().epoch || get().status === "loading") return;
    const patch = folderRescanned(get(), entries);
    if (patch.entries) set((s) => withSelectionHeld(s, patch));
  },

  openSource: async (sourceId, arg) => {
    const source = getSource(sourceId);
    if (!source) return;
    const scope: Scope = { kind: "source", sourceId, arg, label: source.label(arg) };
    const query = get().query;
    set({
      ...scopeLoading(scope, EPOCH_PENDING),
      query: { ...query, sort: sortForScope(scope, query.sort) },
    });
    const epoch = await api.newEpoch();
    if (get().scope !== scope) return;
    set({ epoch });
    try {
      const items = await source.fetch(arg);
      if (get().scope === scope) {
        set(sourceLoaded(items));
      }
    } catch (error) {
      if (get().scope === scope) {
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
  cropsLoaded: (crops, epoch) => {
    if (epoch === get().epoch) set({ crops: { ...get().crops, ...crops } });
  },

  cropApplied: (path, crop) => {
    const crops = { ...get().crops };
    if (crop === null) Reflect.deleteProperty(crops, path);
    else crops[path] = crop;
    set({ crops });
  },

  toggleInspector: () => set({ inspectorVisible: !get().inspectorVisible }),

  togglePanelFold: (id) =>
    set((s) => ({ panelFolds: { ...s.panelFolds, [id]: !(s.panelFolds[id] ?? false) } })),

  toggleFolderPin: (path) => set((s) => ({
    pinnedFolders: s.pinnedFolders.includes(path)
      ? s.pinnedFolders.filter((p) => p !== path)
      : [...s.pinnedFolders, path],
  })),

  togglePanelPin: (id) => set((s) => ({
    pinnedPanels: s.pinnedPanels.includes(id)
      ? s.pinnedPanels.filter((p) => p !== id)
      : [...s.pinnedPanels, id],
  })),

  setPanelOrder: (panelOrder) => set({ panelOrder }),

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(420, Math.max(180, Math.round(px))) }),

  setRightbarWidth: (px) => set({ rightbarWidth: Math.min(480, Math.max(220, Math.round(px))) }),

  // Held: the darkroom collapses pairs and the grid does not, so the list is a different length on either side.
  setGalleryLayout: (layout) => set((s) => withSelectionHeld(s, { galleryLayout: layout })),



  setGridColumns: (columns) => set({ gridColumns: columns }),

  setRowNavigator: (rowNavigator) => set({ rowNavigator }),


  toggleStacking: () =>
    set((s) => withSelectionHeld(s, { stacking: !s.stacking })),

  // Held: every unpicked stack changes which file represents it.
  toggleStackLead: () =>
    set((s) => withSelectionHeld(s, { stackLead: s.stackLead === "jpg" ? "raw" : "jpg" })),

  preferMember: (path) =>
    set((s) => {
      const entry = s.entries.find((e) => e.path === path);
      if (!entry) return {};
      const key = stackKeyOf(entry);
      return withSelectionHeld(
        s,
        { preferredMember: { ...s.preferredMember, [key]: path } },
        path,
      );
    }),

  toggleStackExpanded: (key) =>
    set((s) => {
      const { [key]: open, ...rest } = s.expandedStacks;
      return { expandedStacks: open ? rest : { ...rest, [key]: true } };
    }),

  select: (index) => set((s) => withSelection(s, index)),

  selectAt: (index, mode) => set((s) => withSelectionAt(s, index, mode)),

  selectAll: () =>
    set((s) => {
      const visible = visibleOf(s, s.query);
      // The lead stays put: selecting everything widens what an action reaches, not where it is.
      const index = Math.min(s.selectedIndex ?? 0, visible.length - 1);
      const lead = index < 0 ? undefined : visible[index];
      if (lead === undefined) return {};
      return {
        selectedIndex: index,
        selection: visible.map((e) => e.path),
        selectionAnchor: lead.path,
      };
    }),

  selectForMenu: (index) =>
    set((s) => {
      const entry = visibleOf(s, s.query)[index];
      if (entry !== undefined && s.selection.includes(entry.path)) return { selectedIndex: index };
      return withSelection(s, index);
    }),

  deleted: (paths) => set((s) => withDeleted(s, paths)),

  // Resolved to a file before the mode changes: the viewer stacks pairs and the grid does not. Opening starts fitted.
  openViewer: (index) => {
    const state = get();
    const path = visibleOf(state, state.query)[index]?.path;
    if (path === undefined) return;
    set(
      withSelectionHeld(
        state,
        { viewMode: "viewer", viewerView: null, viewerImg: null, viewerFitted: true },
        path,
      ),
    );
  },

  closeViewer: () => set((s) => withSelectionHeld(s, { viewMode: "gallery" })),

  // An arrow key is a plain click on the next image: it collapses a multi-selection onto the lead.
  navigate: (delta) => {
    const visible = visibleOf(get(), get().query);
    const moved = movedSelection(get(), visible.length, delta);
    if (moved.selectedIndex !== undefined) set(withSelection(get(), moved.selectedIndex));
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

  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  setExportOpen: (open) => set({ exportOpen: open }),

  setExportOptions: (exportOptions) => set({ exportOptions }),

  setExportFolder: (exportFolder) => set({ exportFolder }),

  promptCommand: (commandId) => set({ paletteOpen: true, palettePrompt: commandId }),

  setImageMenu: (imageMenu) => set({ imageMenu }),

  // Fit is a state, not a one-off: a fitted view refits to whatever arrives, a zoomed view holds its place.
  viewerImageLoaded: (size) => {
    const { viewerFitted, viewerView, viewerImg, viewerWin } = get();
    const holding = !viewerFitted && viewerView !== null && viewerImg !== null;
    set({
      viewerImg: size,
      viewerView: holding
        ? heldView(viewerView, viewerImg, size, viewerWin)
        : fitToWindow(size, viewerWin),
      viewerFitted: !holding,
    });
  },

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

/** Per-file EXIF and dimensions; undefined until the background read lands. */
export const META: Channel<ImageMeta | undefined> = storeChannel<AppState, ImageMeta | undefined>(
  useAppStore,
  (s) => s.meta,
  undefined,
);

export * from "./selection";
export * from "./visible";
