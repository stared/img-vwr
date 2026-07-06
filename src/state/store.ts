import { create } from "zustand";

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
  /** Index into `entries` of the image shown in viewer mode. */
  selectedIndex: number;
}

interface AppActions {
  openFolder: (path: string) => Promise<void>;
  thumbReady: (path: string, cacheFile: string, epoch: number) => void;
  thumbFailed: (path: string, error: string, epoch: number) => void;
  openViewer: (index: number) => void;
  closeViewer: () => void;
  navigate: (delta: number) => void;
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
  };
}

/** Move the viewer selection by `delta`, clamped to the folder bounds. */
export function movedSelection(
  state: Pick<AppState, "selectedIndex" | "entries">,
  delta: number,
): Partial<AppState> {
  if (state.entries.length === 0) return {};
  const index = Math.min(state.entries.length - 1, Math.max(0, state.selectedIndex + delta));
  return { selectedIndex: index };
}

export function folderLoaded(entries: FileEntry[]): Partial<AppState> {
  return { entries, status: "loaded" };
}

export function folderFailed(message: string): Partial<AppState> {
  return { entries: [], status: "error", error: message };
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
      set({ viewMode: "viewer", selectedIndex: index });
    }
  },

  closeViewer: () => set({ viewMode: "gallery" }),

  navigate: (delta) => set(movedSelection(get(), delta)),
}));
