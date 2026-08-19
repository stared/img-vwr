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
  EmbedModelInfo,
  FileEntry,
  HdrMethod,
  ImageLabels,
  ImageMeta,
  MetaEntry,
  PersonCluster,
} from "../ipc";
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
  without,
  type FolderStatus,
  type Scope,
} from "./collection";
import { DEFAULT_OPTIONS, type ExportOptions } from "./export";
import { hdrSetsOf, type HdrSet } from "./hdr";
import type { Query, Sort } from "./query";
import {
  collapseStacks,
  photographKeyOf,
  siblingsOf,
  stackKeyOf,
  stackKeyOfPath,
  type StackLead,
} from "./stacks";
import {
  applyQuery,
  defaultQuery,
  usesLabels,
  usesMeta,
  usesPeople,
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
export type GalleryLayout = "grid" | "mosaic" | "timeline" | "map" | "darkroom" | "scenes";

export type MosaicPacking = "order" | "packed";
export type TimelineOrientation = "vertical" | "horizontal";

export type { FolderStatus, Scope } from "./collection";
export { scanBatchArrived, sortForScope } from "./collection";

/** Computed per-image scores backing a transient sort ("similar to …"). */
export interface Similarity {
  /** Chip value describing the anchor: a file name or a quoted phrase. */
  label: string;
  /** What the scores measure distance to; kept for re-ranking as the background index fills in. */
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
  thumbErrors: Record<string, string>;
  /** folder path → direct image count, streamed from background counting. */
  dirCounts: Record<string, number>;
  meta: Record<string, ImageMeta>;
  /** path → user labels (stars, tags), loaded per scope; absent = unlabeled. */
  labels: Record<string, ImageLabels>;
  /** path → stored develop crop, for miniatures; absent = whole frame. */
  crops: Record<string, Crop>;
  inspectorVisible: boolean;
  /** Sidebar sections folded away, by panel id; absent = open. Persisted. */
  panelFolds: Record<string, boolean>;
  /** Right-column section order, panel ids; unknown ids keep registration order after these. Persisted. */
  panelOrder: string[];
  /** Sidebar widths, px — dragged at the inner edge. Persisted. */
  sidebarWidth: number;
  rightbarWidth: number;
  viewMode: ViewMode;
  galleryLayout: GalleryLayout;
  timelineOrientation: TimelineOrientation;
  /** Thumbnail edge on the timeline, px — presentation only, never zoom. */
  timelineThumbPx: number;
  /** The mosaic's target row height, px — presentation only. */
  mosaicRowPx: number;
  /** "order" keeps the sort's order (rows vary in scale to justify); "packed" repacks so everything reads at one scale. */
  mosaicPacking: MosaicPacking;
  gridColumns: number;
  /** Moves the lead one visual row (+1 down, -1 up); registered by the mounted view, which alone knows its geometry; null when it has no second dimension. */
  rowNavigator: ((direction: 1 | -1) => void) | null;
  /** The scenes view's time constant, minutes. */
  sceneGapMin: number;
  /** How much the pictures outvote the clock at scene boundaries, 0..1; matters only while similarities are available. */
  sceneContentWeight: number;
  /** `bands[i][d-1]` scores (entries[i], entries[i-d]); matched to `entries` by identity — stale means the clock alone decides; null pairs are unindexed. */
  sceneSims: { entries: FileEntry[]; bands: (number | null)[][] } | null;
  /** Collapse raw+JPEG pairs into one photograph — only where one is on screen at a time; see `stacksCollapse`. */
  stacking: boolean;
  stackLead: StackLead;
  /** stack key → the member the user chose to show; absent means `stackLead` decides. */
  preferredMember: Record<string, string>;
  /** Photograph keys spread open in the filmstrip; strip-only — the visible list stays collapsed, one photograph one index. */
  expandedStacks: Record<string, true>;
  /** face path → how that HDR set merges; absent means exposure fusion. */
  hdrMethod: Record<string, HdrMethod>;
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
  /** Scores + label behind the "similar" sort; null = no anchor chosen. */
  similarity: Similarity | null;
  /** Face clusters, biggest first; null until a pass has run for this folder. */
  people: PersonCluster[] | null;
  /** photo path → person-cluster ids (detected or implied); rebuilt whenever `people` lands. */
  peopleByPath: Record<string, string[]>;
  /** Face-detection progress; null when idle. */
  facesProgress: { done: number; total: number } | null;
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
  /** Mirror the label store's response for exactly the paths it answered for. */
  labelsApplied: (labels: Record<string, ImageLabels>) => void;
  /** Install stored crops for a scope's paths (epoch-guarded, like labels). */
  cropsLoaded: (crops: Record<string, Crop>, epoch: number) => void;
  /** One photograph's crop changed in the darkroom; null = back to whole. */
  cropApplied: (path: string, crop: Crop | null) => void;
  toggleInspector: () => void;
  togglePanelFold: (id: string) => void;
  setPanelOrder: (order: string[]) => void;
  setSidebarWidth: (px: number) => void;
  setRightbarWidth: (px: number) => void;
  setGalleryLayout: (layout: GalleryLayout) => void;
  setTimelineOrientation: (orientation: TimelineOrientation) => void;
  setTimelineThumbPx: (px: number) => void;
  setMosaicRowPx: (px: number) => void;
  setMosaicPacking: (packing: MosaicPacking) => void;
  setGridColumns: (columns: number) => void;
  setRowNavigator: (navigator: ((direction: 1 | -1) => void) | null) => void;
  setSceneGap: (min: number) => void;
  setSceneContentWeight: (weight: number) => void;
  /** Fresh banded similarities for exactly this visible list. */
  sceneSimsLoaded: (entries: FileEntry[], bands: (number | null)[][]) => void;
  peopleLoaded: (people: PersonCluster[]) => void;
  setFacesProgress: (progress: { done: number; total: number } | null) => void;
  toggleStacking: () => void;
  toggleStackLead: () => void;
  /** Show `path` in place of whatever its stack was showing. */
  preferMember: (path: string) => void;
  toggleStackExpanded: (key: string) => void;
  setHdrMethod: (face: string, method: HdrMethod) => void;
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
  crops: {},
  inspectorVisible: true,
  panelFolds: {},
  panelOrder: [],
  sidebarWidth: 230,
  // Wide enough for the Shot block's one-line exposure row at worst case (five-digit ISO, negative EV).
  rightbarWidth: 310,
  viewMode: "gallery",
  galleryLayout: "grid",
  timelineOrientation: "vertical",
  timelineThumbPx: 64,
  mosaicRowPx: 180,
  mosaicPacking: "order",
  gridColumns: 6,
  rowNavigator: null,
  sceneGapMin: 2,
  sceneContentWeight: 1,
  sceneSims: null,
  // On by default: a raw+JPEG folder otherwise shows every photograph twice.
  stacking: true,
  stackLead: "jpg",
  preferredMember: {},
  expandedStacks: {},
  hdrMethod: {},
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
  similarity: null,
  people: null,
  peopleByPath: {},
  facesProgress: null,
  embedModels: [],
  embedStatus: null,
  embedProgress: null,
  viewerView: null,
  viewerImg: null,
  viewerWin: { width: 0, height: 0 },
  viewerFitted: true,
};

/** From an empty selection an arrow enters at the end it points from: ← lands on the last image, → the first. */
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

/** The viewport is deliberately left alone: a zoomed view holds its place across selection changes — see `heldView`. */
export function withSelection(state: VisibleInputs, index: number | null): Partial<AppState> {
  const entry = index === null ? undefined : visibleOf(state, state.query)[index];
  if (index === null || entry === undefined) {
    return { selectedIndex: null, selection: [], selectionAnchor: null };
  }
  return { selectedIndex: index, selection: [entry.path], selectionAnchor: entry.path };
}

export type SelectMode =
  /** This one instead of whatever was selected. */
  | "replace"
  /** This one as well, or out again if it was already in (⌘/Ctrl). */
  | "extend"
  /** Everything from the anchor through to this one (⇧). */
  | "range";

export function selectMode(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): SelectMode {
  if (e.shiftKey) return "range";
  if (e.metaKey || e.ctrlKey) return "extend";
  return "replace";
}

/** Click on the image at `index` — see `SelectMode`. */
export function withSelectionAt(
  state: VisibleInputs,
  index: number,
  mode: SelectMode,
): Partial<AppState> {
  const visible = visibleOf(state, state.query);
  const entry = visible[index];
  if (entry === undefined) return {};

  if (mode === "replace") return withSelection(state, index);

  if (mode === "extend") {
    if (!state.selection.includes(entry.path)) {
      // Picked up: the lead and the anchor both move onto it — a range reaches from the last thing touched.
      return {
        selectedIndex: index,
        selection: [...state.selection, entry.path],
        selectionAnchor: entry.path,
      };
    }
    // Put back down: the lead moves to the first of the rest; taking the last one out leaves nothing selected.
    const rest = new Set(state.selection.filter((p) => p !== entry.path));
    const lead = visible.findIndex((e) => rest.has(e.path));
    const leadEntry = lead < 0 ? undefined : visible[lead];
    if (leadEntry === undefined) {
      return { selectedIndex: null, selection: [], selectionAnchor: null };
    }
    return {
      selectedIndex: lead,
      selection: visible.filter((e) => rest.has(e.path)).map((e) => e.path),
      selectionAnchor: leadEntry.path,
    };
  }

  // A range with nothing to reach from is just a click.
  const anchored = visible.findIndex((e) => e.path === state.selectionAnchor);
  const from = anchored < 0 ? index : anchored;
  const [lo, hi] = from <= index ? [from, index] : [index, from];
  return {
    selectedIndex: index,
    selection: visible.slice(lo, hi + 1).map((e) => e.path),
    // The anchor stays put, so reaching back the other way corrects the range.
    selectionAnchor: visible[from]?.path ?? entry.path,
  };
}

/** Everything `visibleOf` reads, plus the selection it is an index into. */
type VisibleInputs = Pick<
  AppState,
  | "entries"
  | "query"
  | "selectedIndex"
  | "selection"
  | "selectionAnchor"
  | "meta"
  | "similarity"
  | "labels"
  | "peopleByPath"
  | "stacking"
  | "stackLead"
  | "preferredMember"
  | "viewMode"
  | "galleryLayout"
>;

/** Stacking applies only where one photograph is on screen at a time; the grid, timeline and map list every file. */
export function stacksCollapse(
  state: Pick<AppState, "stacking" | "viewMode" | "galleryLayout">,
): boolean {
  return (
    state.stacking &&
    (state.viewMode === "viewer" ||
      state.galleryLayout === "darkroom" ||
      state.galleryLayout === "scenes")
  );
}

/** Scores for exactly this visible list, matched by identity — the memoized list keeps its object while on screen. */
export function sceneSimsFor(
  state: Pick<AppState, "sceneSims">,
  visible: FileEntry[],
): (number | null)[][] | null {
  return state.sceneSims !== null && state.sceneSims.entries === visible
    ? state.sceneSims.bands
    : null;
}

/** The photographs the selection means, in the order they are on screen. */
export function chosenEntries(state: AppState): FileEntry[] {
  const picked = new Set(state.selection);
  return visibleOf(state, state.query).filter((e) => picked.has(e.path));
}

/** Where a pair is collapsed into one photograph, acting on "it" means both files; where listed apart, only the picked file. */
export function filesBehind(state: AppState, entries: FileEntry[]): FileEntry[] {
  if (!stacksCollapse(state)) return entries;
  const files = new Map<string, FileEntry>();
  for (const entry of entries) {
    files.set(entry.path, entry);
    for (const sibling of siblingsOf(state.entries, entry)) files.set(sibling.path, sibling);
  }
  return [...files.values()];
}

/** Re-expresses the selection by path across a list change; `landOn` overrides where the lead lands (e.g. picking a pair's JPEG). */
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
  const after = visibleOf(next, next.query);
  return {
    ...patch,
    ...reselected(after, landOn ?? before ?? null, state.selection, state.selectionAnchor),
  };
}

/** The selection, re-expressed against a visible list that just changed. */
function reselected(
  after: FileEntry[],
  wanted: string | null,
  chosen: readonly string[],
  anchor: string | null,
): Pick<AppState, "selectedIndex" | "selection" | "selectionAnchor"> {
  let index = wanted === null ? -1 : after.findIndex((e) => e.path === wanted);
  if (index < 0 && wanted !== null) {
    // The file may survive as the other of its pair — collapsing a stack is exactly that.
    const key = stackKeyOfPath(wanted);
    index = after.findIndex((e) => stackKeyOf(e) === key);
  }
  // Rebuilt from the list, so the selection stays in on-screen order however the sort just moved it.
  const want = new Set(chosen);
  const survivors = want.size === 0 ? [] : after.filter((e) => want.has(e.path));
  const first = survivors[0];
  if (index < 0 && first !== undefined) {
    // The lead is gone but other picked photographs survive; the lead moves onto the first of them.
    index = after.indexOf(first);
  }
  const lead = index < 0 ? undefined : after[index];
  if (lead === undefined) return { selectedIndex: null, selection: [], selectionAnchor: null };
  // The lead is in the selection by construction — even when it arrived as the other half of a stack.
  const selection = after.filter((e) => e === lead || want.has(e.path)).map((e) => e.path);
  return {
    selectedIndex: index,
    selection,
    selectionAnchor:
      anchor !== null && after.some((e) => e.path === anchor) ? anchor : lead.path,
  };
}

/** Applied the moment a delete returns (the watcher reports later and finds nothing to do); deleting the lead lands on whatever takes its place. */
export function withDeleted(
  state: VisibleInputs & Pick<AppState, "thumbs" | "thumbErrors">,
  gone: readonly string[],
): Partial<AppState> {
  const drop = new Set(gone);
  const entries = state.entries.filter((e) => !drop.has(e.path));
  if (entries.length === state.entries.length) return {};
  const patch = {
    entries,
    thumbs: without(state.thumbs, drop),
    thumbErrors: without(state.thumbErrors, drop),
  };
  const held = withSelectionHeld(state, patch);
  if (held.selectedIndex !== null || state.selectedIndex === null) return held;
  const after = visibleOf({ ...state, ...patch } as VisibleInputs, state.query);
  const index = Math.min(state.selectedIndex, after.length - 1);
  const landing = index < 0 ? undefined : after[index];
  if (landing === undefined) return held;
  return { ...held, selectedIndex: index, selection: [landing.path], selectionAnchor: landing.path };
}

/** Photographs that survive the new filters stay selected; the rest are dropped, never replaced. */
export function withQuery(state: VisibleInputs, query: Query): Partial<AppState> {
  const held = withSelectionHeld(state, { query });
  // A filter that hides the viewed photograph must not strand an empty viewer; it yields to the gallery.
  if (state.viewMode === "viewer" && held.selectedIndex === null) {
    return { ...held, viewMode: "gallery" };
  }
  return held;
}

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
    });
    const epoch = await newEpoch();
    // Another scope was opened while the epoch was being fetched.
    if (get().scope !== scope) return;
    set({ epoch });
    try {
      // Entries stream in as scanBatch events; only the error branch matters here.
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

  labelsApplied: (labels) => set({ labels: { ...get().labels, ...labels } }),

  cropsLoaded: (crops, epoch) => {
    if (epoch === get().epoch) set({ crops: { ...get().crops, ...crops } });
  },

  cropApplied: (path, crop) => {
    const crops = { ...get().crops };
    if (crop === null) delete crops[path];
    else crops[path] = crop;
    set({ crops });
  },

  toggleInspector: () => set({ inspectorVisible: !get().inspectorVisible }),

  togglePanelFold: (id) =>
    set((s) => ({ panelFolds: { ...s.panelFolds, [id]: !(s.panelFolds[id] ?? false) } })),

  setPanelOrder: (panelOrder) => set({ panelOrder }),

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(420, Math.max(180, Math.round(px))) }),

  setRightbarWidth: (px) => set({ rightbarWidth: Math.min(480, Math.max(220, Math.round(px))) }),

  // Held: the darkroom collapses pairs and the grid does not, so the list is a different length on either side.
  setGalleryLayout: (layout) => set((s) => withSelectionHeld(s, { galleryLayout: layout })),

  setTimelineOrientation: (orientation) => set({ timelineOrientation: orientation }),

  setTimelineThumbPx: (px) => set({ timelineThumbPx: px }),
  setMosaicRowPx: (px) => set({ mosaicRowPx: px }),
  setMosaicPacking: (packing) => set({ mosaicPacking: packing }),

  setGridColumns: (columns) => set({ gridColumns: columns }),

  setRowNavigator: (rowNavigator) => set({ rowNavigator }),

  setSceneGap: (min) => set({ sceneGapMin: min }),

  setSceneContentWeight: (weight) => set({ sceneContentWeight: weight }),

  sceneSimsLoaded: (entries, bands) => set({ sceneSims: { entries, bands } }),

  peopleLoaded: (people) => {
    const peopleByPath: Record<string, string[]> = {};
    for (const cluster of people) {
      for (const path of [...cluster.photos, ...cluster.implied]) {
        (peopleByPath[path] ??= []).push(cluster.id);
      }
    }
    set({ people, peopleByPath });
  },

  setFacesProgress: (facesProgress) => set({ facesProgress }),

  toggleStacking: () =>
    set((s) => withSelectionHeld(s, { stacking: !s.stacking })),

  // Held: every unpicked stack changes which file represents it.
  toggleStackLead: () =>
    set((s) => withSelectionHeld(s, { stackLead: s.stackLead === "jpg" ? "raw" : "jpg" })),

  preferMember: (path) =>
    set((s) => {
      const entry = s.entries.find((e) => e.path === path);
      if (!entry) return {};
      // Keyed by the photograph — for a frame of an HDR set that is the set, so picking a member swaps the whole bracket.
      const key = photographKeyOf(entry, hdrOf(s).keyByStack);
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

  setHdrMethod: (face, method) =>
    set((s) => ({ hdrMethod: { ...s.hdrMethod, [face]: method } })),

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

/* All consumers share one memoized filter+sort result, held by input identity; one slot suffices since every consumer reads the same store state. */
let visibleCache: {
  entries: FileEntry[];
  query: Query;
  meta: Record<string, ImageMeta> | null;
  scores: Record<string, number> | null;
  labels: Record<string, ImageLabels> | null;
  people: Record<string, string[]> | null;
  stacking: boolean;
  lead: StackLead;
  preferred: Record<string, string>;
  hdrKeys: ReadonlyMap<string, string> | null;
  result: FileEntry[];
} | null = null;

/* Memoized by input identity and additionally by answer: a meta batch that taught nothing about brackets keeps the previous maps' identity. */
let hdrCache: {
  entries: FileEntry[];
  meta: Record<string, ImageMeta>;
  signature: string;
  sets: HdrSet[];
  /** Every member stem's stack key → the set's face path. */
  keyByStack: ReadonlyMap<string, string>;
  /** Face path → its set, for anything fronting one photograph. */
  byFace: ReadonlyMap<string, HdrSet>;
} | null = null;

export function hdrOf(state: Pick<AppState, "entries" | "meta">): {
  sets: HdrSet[];
  keyByStack: ReadonlyMap<string, string>;
  byFace: ReadonlyMap<string, HdrSet>;
} {
  const c = hdrCache;
  if (c && c.entries === state.entries && c.meta === state.meta) return c;
  const sets = hdrSetsOf(state.entries, (path) => state.meta[path] ?? null);
  const signature = sets.map((s) => `${s.face.path}:${s.frames.length}`).join("|");
  if (c && c.signature === signature) {
    hdrCache = { ...c, entries: state.entries, meta: state.meta };
    return hdrCache;
  }
  const keyByStack = new Map<string, string>();
  const byFace = new Map<string, HdrSet>();
  for (const set of sets) {
    byFace.set(set.face.path, set);
    for (const frame of set.frames) keyByStack.set(stackKeyOf(frame), set.face.path);
  }
  hdrCache = { entries: state.entries, meta: state.meta, signature, sets, keyByStack, byFace };
  return hdrCache;
}

/** Entries with filters + sort applied, memoized across all callers. */
export function visibleOf(
  state: Pick<
    AppState,
    | "entries"
    | "meta"
    | "similarity"
    | "labels"
    | "peopleByPath"
    | "stacking"
    | "stackLead"
    | "preferredMember"
    | "viewMode"
    | "galleryLayout"
  >,
  query: Query,
): FileEntry[] {
  // Only channels the query reads participate — streaming batches must not re-sort what a plain name sort ignores.
  const meta = usesMeta(query) ? state.meta : null;
  const scores = usesScores(query) ? (state.similarity?.scores ?? null) : null;
  const labels = usesLabels(query) ? state.labels : null;
  const people = usesPeople(query) ? state.peopleByPath : null;
  const collapsing = stacksCollapse(state);
  return applyQueryMemo(
    state.entries,
    query,
    meta,
    scores,
    labels,
    people,
    collapsing,
    state.stackLead,
    state.preferredMember,
    collapsing ? hdrOf(state).keyByStack : null,
  );
}

function applyQueryMemo(
  entries: FileEntry[],
  query: Query,
  meta: Record<string, ImageMeta> | null,
  scores: Record<string, number> | null,
  labels: Record<string, ImageLabels> | null,
  people: Record<string, string[]> | null,
  stacking: boolean,
  lead: StackLead,
  preferred: Record<string, string>,
  hdrKeys: ReadonlyMap<string, string> | null,
): FileEntry[] {
  const c = visibleCache;
  if (
    c &&
    c.entries === entries &&
    c.query === query &&
    c.meta === meta &&
    c.scores === scores &&
    c.labels === labels &&
    c.people === people &&
    c.stacking === stacking &&
    c.lead === lead &&
    c.preferred === preferred &&
    c.hdrKeys === hdrKeys
  ) {
    return c.result;
  }
  const filtered = applyQuery(entries, query, {
    meta: meta ?? {},
    scores: scores ?? {},
    labels: labels ?? {},
    people: people ?? {},
  });
  // Stacking collapses what the query already decided, so a filter matching one member of a pair still shows it.
  const result = stacking ? collapseStacks(filtered, preferred, lead, hdrKeys) : filtered;
  visibleCache = {
    entries,
    query,
    meta,
    scores,
    labels,
    people,
    stacking,
    lead,
    preferred,
    hdrKeys,
    result,
  };
  return result;
}

/** Every panel that describes "the current image" goes through here, so all agree on the empty case. */
export function useSelectedEntry(): FileEntry | null {
  const entries = useVisibleEntries();
  const index = useAppStore((s) => s.selectedIndex);
  return index === null ? null : (entries[index] ?? null);
}

export function useVisibleEntries(): FileEntry[] {
  const entries = useAppStore((s) => s.entries);
  const query = useAppStore((s) => s.query);
  // Subscribe to a data channel only while the query reads it — otherwise every streamed batch re-renders every consumer.
  const meta = useAppStore((s) => (usesMeta(s.query) ? s.meta : null));
  const scores = useAppStore((s) => (usesScores(s.query) ? (s.similarity?.scores ?? null) : null));
  const labels = useAppStore((s) => (usesLabels(s.query) ? s.labels : null));
  const people = useAppStore((s) => (usesPeople(s.query) ? s.peopleByPath : null));
  const stacking = useAppStore(stacksCollapse);
  const lead = useAppStore((s) => s.stackLead);
  const preferred = useAppStore((s) => s.preferredMember);
  // Identity-stable while detection's answer stands, so this fires only when a bracket appears or dissolves.
  const hdrKeys = useAppStore((s) => (stacksCollapse(s) ? hdrOf(s).keyByStack : null));
  return applyQueryMemo(
    entries,
    query,
    meta,
    scores,
    labels,
    people,
    stacking,
    lead,
    preferred,
    hdrKeys,
  );
}
