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
import type { EmbedModelInfo, FileEntry, ImageLabels, ImageMeta, MetaEntry } from "../ipc";
import { newEpoch, scanFolder } from "../ipc";
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
import type { Query, Sort } from "./query";
import { collapseStacks, stackKeyOf, stackKeyOfPath } from "./stacks";
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

export type ViewMode = "gallery" | "viewer";
export type GalleryLayout = "grid" | "timeline" | "map" | "darkroom";
export type TimelineOrientation = "vertical" | "horizontal";

export type { FolderStatus, Scope } from "./collection";
export { scanBatchArrived, sortForScope } from "./collection";

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
  /** Which way the timeline's time axis runs. */
  timelineOrientation: TimelineOrientation;
  /** Thumbnail edge on the timeline, px — presentation only, never zoom. */
  timelineThumbPx: number;
  /** How many thumbnails the grid fits in one row; cells size to suit. */
  gridColumns: number;
  /**
   * Collapse a raw file and the JPEG shot beside it into one photograph.
   *
   * Only where one photograph is on screen at a time — see `stacksCollapse`.
   * Presentation only: the collection still holds both files and format
   * filters still match both. Turning it off puts everything back with no
   * state to unwind.
   */
  stacking: boolean;
  /**
   * stack key → the member the user chose to show for that stack.
   *
   * Absent means the default, which is the raw file. Recorded per stack
   * rather than as a global "show JPEGs" mode because the choice is about
   * one photograph — usually that the camera got a particular frame right.
   */
  preferredMember: Record<string, string>;
  /**
   * Index into the VISIBLE (query-applied) list, or null when nothing is
   * selected.
   *
   * Nullable on purpose: "no image selected" is a real state, not something
   * to paper over by defaulting to the first item. A folder opens with
   * nothing selected, and panels say so rather than describing an image the
   * user never picked.
   */
  selectedIndex: number | null;
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
  /** The open folder, re-read after something changed on disk. */
  folderChanged: (entries: FileEntry[], epoch: number) => void;
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
  setTimelineOrientation: (orientation: TimelineOrientation) => void;
  setTimelineThumbPx: (px: number) => void;
  setGridColumns: (columns: number) => void;
  toggleStacking: () => void;
  /** Show `path` in place of whatever its stack was showing. */
  preferMember: (path: string) => void;
  /** Select one image, or nothing (null) — clicking empty space, or Esc. */
  select: (index: number | null) => void;
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
  timelineOrientation: "vertical",
  timelineThumbPx: 64,
  gridColumns: 6,
  // On by default: working through a folder shot raw+JPEG otherwise means
  // every photograph twice, which is what the camera wrote but not what was
  // taken.
  stacking: true,
  preferredMember: {},
  selectedIndex: null,
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

/**
 * Move the selection by `delta` within `count` items. From an empty selection
 * an arrow key enters the collection at whichever end it points from, so ←
 * lands on the last image and → the first.
 */
export function movedSelection(
  state: Pick<AppState, "selectedIndex">,
  count: number,
  delta: number,
): Partial<AppState> {
  if (count === 0) return {};
  const index =
    state.selectedIndex === null
      ? delta < 0
        ? count - 1
        : 0
      : Math.min(count - 1, Math.max(0, state.selectedIndex + delta));
  if (index === state.selectedIndex) return {};
  return { selectedIndex: index };
}

/**
 * Select an index, or nothing.
 *
 * The viewport is deliberately left alone. A frame at fit refits itself when
 * the next image loads, and one that has been zoomed in holds its
 * magnification and its place in the frame — which is the whole point of
 * zooming in while stepping through a sequence: you are checking the same
 * feature on take after take, and being thrown back to fit each time means
 * finding it again every time. See `heldView`.
 */
export function withSelection(index: number | null): Partial<AppState> {
  return { selectedIndex: index };
}

/**
 * Change the query while keeping the same image selected if it survives the
 * new filters. If it does not, the selection empties rather than jumping to
 * the top: the image the user was looking at is gone, and silently selecting
 * a different one would misreport what the panels are describing.
 */
/** Everything `visibleOf` reads, which is what a selection is an index into. */
type VisibleInputs = Pick<
  AppState,
  | "entries"
  | "query"
  | "selectedIndex"
  | "meta"
  | "similarity"
  | "labels"
  | "stacking"
  | "preferredMember"
  | "viewMode"
  | "galleryLayout"
>;

/**
 * Whether raw+JPEG pairs collapse right now.
 *
 * Stacking is about working through a sequence one photograph at a time, so
 * it applies exactly where that is what is happening. The grid, the timeline
 * and the map list every file — they are how you see what is on the card.
 */
export function stacksCollapse(
  state: Pick<AppState, "stacking" | "viewMode" | "galleryLayout">,
): boolean {
  return state.stacking && (state.viewMode === "viewer" || state.galleryLayout === "darkroom");
}

/**
 * Apply a change that reorders or resizes the visible list, keeping the
 * selection on the same photograph.
 *
 * The selection is an index, so anything that changes the list underneath it
 * would otherwise silently move it to a different image. Following the path
 * instead is what makes filtering, sorting and stacking safe to change while
 * something is selected.
 *
 * `landOn` is for the case where the change is itself about which file
 * represents a photograph: picking the JPEG of a pair should leave the
 * selection on the JPEG, not on whatever used to be there.
 */
export function withSelectionHeld(
  state: VisibleInputs,
  patch: Partial<AppState>,
  landOn?: string,
): Partial<AppState> {
  const before =
    state.selectedIndex === null
      ? undefined
      : visibleOf(state, state.query)[state.selectedIndex]?.path;
  const next = { ...state, ...patch } as VisibleInputs;
  const wanted = landOn ?? before;
  if (!wanted) return { ...patch, selectedIndex: null };
  const after = visibleOf(next, next.query);
  let index = after.findIndex((e) => e.path === wanted);
  if (index < 0) {
    // The file itself is gone from the list, but its photograph may still be
    // there under the other of a pair — collapsing a stack is exactly that.
    const key = stackKeyOfPath(wanted);
    index = after.findIndex((e) => stackKeyOf(e) === key);
  }
  return { ...patch, selectedIndex: index >= 0 ? index : null };
}

export function withQuery(state: VisibleInputs, query: Query): Partial<AppState> {
  return withSelectionHeld(state, { query });
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
    const scope: Scope = { kind: "folder", path, recursive };
    const query = get().query;
    // The UI flips before ANY round-trip: a click must never wait on IPC.
    set({
      ...scopeLoading(scope, EPOCH_PENDING),
      query: { ...query, sort: sortForScope(scope, query.sort) },
    });
    const epoch = await newEpoch();
    // Another scope was opened while the epoch was being fetched.
    if (get().scope !== scope) return;
    set({ epoch });
    try {
      // Entries stream in as scanBatch events; this resolves when the walk
      // ends, so only the error branch matters here.
      await scanFolder(path, recursive, epoch);
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

  /**
   * The folder changed on disk and has been re-read.
   *
   * Held, because the list is about to grow or shrink under a selection that
   * is an index into it: a card finishing its import while you are looking at
   * frame 40 must not move you to a different photograph. A rescan that found
   * nothing new returns an empty patch and never reaches here.
   *
   * Ignored while the first scan is still streaming — the two would fight
   * over `entries`, and the scan is the more authoritative of them. The
   * watcher will report again once the copying settles.
   */
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
    const epoch = await newEpoch();
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
  labelsLoaded: (labels, epoch) => {
    if (epoch === get().epoch) set({ labels: { ...get().labels, ...labels } });
  },

  labelApplied: (path, labels) => set({ labels: { ...get().labels, [path]: labels } }),

  toggleStats: () => set({ statsVisible: !get().statsVisible }),

  // Held, because the darkroom collapses raw+JPEG pairs and the grid does
  // not: the list is a different length on either side of this.
  setGalleryLayout: (layout) => set((s) => withSelectionHeld(s, { galleryLayout: layout })),

  setTimelineOrientation: (orientation) => set({ timelineOrientation: orientation }),

  setTimelineThumbPx: (px) => set({ timelineThumbPx: px }),

  setGridColumns: (columns) => set({ gridColumns: columns }),

  toggleStacking: () =>
    set((s) => withSelectionHeld(s, { stacking: !s.stacking })),

  preferMember: (path) =>
    set((s) => {
      const entry = s.entries.find((e) => e.path === path);
      if (!entry) return {};
      return withSelectionHeld(
        s,
        { preferredMember: { ...s.preferredMember, [stackKeyOf(entry)]: path } },
        path,
      );
    }),

  select: (index) => set(withSelection(index)),

  // The index is into the list as it is *now*; the viewer stacks pairs and
  // the grid does not, so it is resolved to a file before the mode changes
  // and followed across. Opening starts fitted, whatever the last image did.
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

  /**
   * A new set of pixels is on screen: either the next photograph, or the same
   * one re-developed after a slider moved.
   *
   * Fit is a *state*, not a one-off: a view that is tracking fit refits to
   * whatever just arrived, and a view that has been zoomed in holds where it
   * was. That is what makes both "step to the next take and check the same
   * eye at 100%" and "drag contrast while zoomed in" work — before this, every
   * arriving frame snapped the image back to fit.
   */
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
  stacking: boolean;
  preferred: Record<string, string>;
  result: FileEntry[];
} | null = null;

/** Entries with filters + sort applied, memoized across all callers. */
export function visibleOf(
  state: Pick<
    AppState,
    | "entries"
    | "meta"
    | "similarity"
    | "labels"
    | "stacking"
    | "preferredMember"
    | "viewMode"
    | "galleryLayout"
  >,
  query: Query,
): FileEntry[] {
  // Only the channels the query reads participate — streaming meta/label
  // batches must not re-sort thousands of entries a plain name sort ignores.
  const meta = usesMeta(query) ? state.meta : null;
  const scores = usesScores(query) ? (state.similarity?.scores ?? null) : null;
  const labels = usesLabels(query) ? state.labels : null;
  return applyQueryMemo(
    state.entries,
    query,
    meta,
    scores,
    labels,
    stacksCollapse(state),
    state.preferredMember,
  );
}

function applyQueryMemo(
  entries: FileEntry[],
  query: Query,
  meta: Record<string, ImageMeta> | null,
  scores: Record<string, number> | null,
  labels: Record<string, ImageLabels> | null,
  stacking: boolean,
  preferred: Record<string, string>,
): FileEntry[] {
  const c = visibleCache;
  if (
    c &&
    c.entries === entries &&
    c.query === query &&
    c.meta === meta &&
    c.scores === scores &&
    c.labels === labels &&
    c.stacking === stacking &&
    c.preferred === preferred
  ) {
    return c.result;
  }
  const filtered = applyQuery(entries, query, {
    meta: meta ?? {},
    scores: scores ?? {},
    labels: labels ?? {},
  });
  // Stacking collapses what the query already decided, so a filter that
  // matches only one member of a pair still shows that member.
  const result = stacking ? collapseStacks(filtered, preferred) : filtered;
  visibleCache = { entries, query, meta, scores, labels, stacking, preferred, result };
  return result;
}

/** The gallery/viewer's working set: folder entries with filters + sort applied. */
/**
 * The selected image, or null when nothing is selected. Every panel that
 * describes "the current image" goes through here, so they agree on what is
 * selected and all handle the empty case the same way.
 */
export function useSelectedEntry(): FileEntry | null {
  const entries = useVisibleEntries();
  const index = useAppStore((s) => s.selectedIndex);
  return index === null ? null : (entries[index] ?? null);
}

export function useVisibleEntries(): FileEntry[] {
  const entries = useAppStore((s) => s.entries);
  const query = useAppStore((s) => s.query);
  // Subscribe to a data channel only while the query reads it — otherwise
  // every streamed meta/label batch re-renders every consumer for nothing.
  const meta = useAppStore((s) => (usesMeta(s.query) ? s.meta : null));
  const scores = useAppStore((s) => (usesScores(s.query) ? (s.similarity?.scores ?? null) : null));
  const labels = useAppStore((s) => (usesLabels(s.query) ? s.labels : null));
  const stacking = useAppStore(stacksCollapse);
  const preferred = useAppStore((s) => s.preferredMember);
  return applyQueryMemo(entries, query, meta, scores, labels, stacking, preferred);
}
