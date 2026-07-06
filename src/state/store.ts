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
import type { FileEntry } from "../ipc";
import { newEpoch, scanFolder } from "../ipc";

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
  viewMode: ViewMode;
  /** Index into `entries` of the selected image (gallery highlight & viewer). */
  selectedIndex: number;
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
  openViewer: (index: number) => void;
  closeViewer: () => void;
  navigate: (delta: number) => void;
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
  viewMode: "gallery",
  selectedIndex: 0,
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

/** Move the selection by `delta`, clamped; leaving the image resets the viewport. */
export function movedSelection(
  state: Pick<AppState, "selectedIndex" | "entries">,
  delta: number,
): Partial<AppState> {
  if (state.entries.length === 0) return {};
  const index = Math.min(state.entries.length - 1, Math.max(0, state.selectedIndex + delta));
  if (index === state.selectedIndex) return {};
  return { selectedIndex: index, viewerView: null, viewerImg: null, viewerFitted: true };
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

  openViewer: (index) => {
    if (index >= 0 && index < get().entries.length) {
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

  navigate: (delta) => set(movedSelection(get(), delta)),

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
