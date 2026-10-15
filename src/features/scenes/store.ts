import { create } from "zustand";

import type { FileEntry } from "../../ipc";
import { settingsStore } from "../../state/settingsStore";

export const useSceneSettings = settingsStore(
  "imgvwr.scenes.v1",
  {
    /** The time constant, minutes. */
    gapMin: 2,
    /** How much the pictures outvote the clock at scene boundaries, 0..1; matters only while similarities are available. */
    contentWeight: 1,
  },
  {},
  { gapMin: "sceneGapMin", contentWeight: "sceneContentWeight" },
);

/** Banded embedding similarities for exactly `entries`, the visible list they were computed for. */
export const useSceneSims = create<{
  sims: { entries: FileEntry[]; bands: (number | null)[][] } | null;
}>()(() => ({ sims: null }));

/** Similarities for exactly this visible list, matched by identity — the memoized list keeps its object while on screen. */
export function simsFor(visible: FileEntry[]): (number | null)[][] | null {
  const { sims } = useSceneSims.getState();
  return sims !== null && sims.entries === visible ? sims.bands : null;
}
