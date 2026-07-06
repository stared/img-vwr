import { create } from "zustand";

import type { FileEntry } from "../ipc";
import { scanFolder } from "../ipc";

export type FolderStatus = "idle" | "loading" | "loaded" | "error";

export interface AppState {
  folderPath: string | null;
  entries: FileEntry[];
  status: FolderStatus;
  error: string | null;
}

interface AppActions {
  openFolder: (path: string) => Promise<void>;
}

export const initialState: AppState = {
  folderPath: null,
  entries: [],
  status: "idle",
  error: null,
};

/* Pure transitions — actions only apply these. */

export function folderLoading(path: string): Partial<AppState> {
  return { folderPath: path, entries: [], status: "loading", error: null };
}

export function folderLoaded(entries: FileEntry[]): Partial<AppState> {
  return { entries, status: "loaded" };
}

export function folderFailed(message: string): Partial<AppState> {
  return { entries: [], status: "error", error: message };
}

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  ...initialState,

  openFolder: async (path) => {
    set(folderLoading(path));
    try {
      const entries = await scanFolder(path);
      // Ignore a stale response if the user already opened another folder.
      if (get().folderPath === path) {
        set(folderLoaded(entries));
      }
    } catch (error) {
      if (get().folderPath === path) {
        set(folderFailed(error instanceof Error ? error.message : String(error)));
      }
    }
  },
}));
