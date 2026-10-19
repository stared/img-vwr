import { create } from "zustand";

import type { ImageLabels } from "../../ipc";
import { storeChannel } from "../../registry/channels";
import { useAppStore } from "../../state/store";

interface LabelsState {
  /** path → stars and tags, for the open scope; absent = unlabeled. */
  labels: Record<string, ImageLabels>;
  /** Merge a stored batch, unless the scope moved on while it was read. */
  loaded: (labels: Record<string, ImageLabels>, epoch: number) => void;
  /** Mirror the label store's answer for exactly the paths it answered for. */
  applied: (labels: Record<string, ImageLabels>) => void;
  reset: () => void;
}

export const useLabelsStore = create<LabelsState>()((set, get) => ({
  labels: {},
  loaded: (labels, epoch) => {
    if (epoch === useAppStore.getState().epoch) set({ labels: { ...get().labels, ...labels } });
  },
  applied: (labels) => set({ labels: { ...get().labels, ...labels } }),
  reset: () => set({ labels: {} }),
}));

/** An image nobody labeled: genuinely no stars and no tags, not unknown. */
const UNLABELED: ImageLabels = { stars: null, tags: [] };

export const LABELS = storeChannel<LabelsState, ImageLabels>(
  useLabelsStore,
  (s) => s.labels,
  UNLABELED,
);
