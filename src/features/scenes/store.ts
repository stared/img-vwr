import { create } from "zustand";

import type { FileEntry } from "../../ipc";

interface ScenesState {
  /** The time constant, minutes. */
  gapMin: number;
  /** How much the pictures outvote the clock at scene boundaries, 0..1; matters only while similarities are available. */
  contentWeight: number;
  /** Banded embedding similarities for exactly `entries`, the visible list they were computed for. */
  sims: { entries: FileEntry[]; bands: (number | null)[][] } | null;
}

const KEY = "imgvwr.scenes.v1";

/** Remembered per viewer; a missing or unreadable record falls back to the defaults. */
function saved(): Pick<ScenesState, "gapMin" | "contentWeight"> {
  const defaults = { gapMin: 2, contentWeight: 1 };
  try {
    // Before scenes had their own record, the app session carried sceneGapMin/sceneContentWeight.
    const own = localStorage.getItem(KEY);
    const legacy = (o: Record<string, unknown>) => ({ gapMin: o.sceneGapMin, contentWeight: o.sceneContentWeight });
    const raw = own ?? localStorage.getItem("imgvwr.session.v1");
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const o =
      own === null && typeof parsed === "object" && parsed !== null
        ? legacy(parsed as Record<string, unknown>)
        : parsed;
    if (typeof o !== "object" || o === null) return defaults;
    const r = o as Record<string, unknown>;
    return {
      gapMin: typeof r.gapMin === "number" ? r.gapMin : defaults.gapMin,
      contentWeight: typeof r.contentWeight === "number" ? r.contentWeight : defaults.contentWeight,
    };
  } catch {
    return defaults;
  }
}

export const useScenesStore = create<ScenesState>()(() => ({ ...saved(), sims: null }));

useScenesStore.subscribe((s, before) => {
  if (s.gapMin === before.gapMin && s.contentWeight === before.contentWeight) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ gapMin: s.gapMin, contentWeight: s.contentWeight }));
  } catch {
    // Private mode or full storage: the setting just lasts for this session.
  }
});

/** Similarities for exactly this visible list, matched by identity — the memoized list keeps its object while on screen. */
export function simsFor(visible: FileEntry[]): (number | null)[][] | null {
  const { sims } = useScenesStore.getState();
  return sims !== null && sims.entries === visible ? sims.bands : null;
}
