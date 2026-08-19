import type { Crop, FileEntry } from "../ipc";
import { developCrops } from "../ipc";
import { isCropped } from "./crop";
import { useDevelopStore } from "./develop";
import { useAppStore } from "./store";

/** Keeps the store's path → crop map current from the develop DB and the open darkroom session. */
export function registerThumbCrops(): void {
  let lastEntries: FileEntry[] | null = null;
  let lastEpoch = -1;
  let asked = new Set<string>();
  useAppStore.subscribe((state) => {
    if (state.entries === lastEntries) return;
    lastEntries = state.entries;
    if (state.epoch !== lastEpoch) {
      lastEpoch = state.epoch;
      asked = new Set();
    }
    const fresh = state.entries.filter((e) => !asked.has(e.path));
    if (fresh.length === 0) return;
    for (const entry of fresh) asked.add(entry.path);
    const epoch = state.epoch;
    void developCrops(fresh.map((e) => e.path)).then(
      (crops) => useAppStore.getState().cropsLoaded(crops, epoch),
      () => {},
    );
  });

  // Identity guard works: `change()` replaces the settings object but carries the crop through by reference on non-crop edits.
  let last: { path: string; crop: Crop } | null = null;
  useDevelopStore.subscribe((state) => {
    const session = state.session;
    if (!session) return;
    const crop = session.settings.crop;
    if (last !== null && last.path === session.path && last.crop === crop) return;
    last = { path: session.path, crop };
    useAppStore.getState().cropApplied(session.path, isCropped(crop) ? crop : null);
  });
}
