import { create } from "zustand";

import { api, events, type EmbedModelInfo } from "../ipc";
import { useAppStore } from "./store";

/* The image-embedding model, shared by everything that compares photographs by content (scenes, similarity, people). */

export interface EmbedStatus {
  modelId: string;
  phase: "downloading" | "loading" | "ready" | "error";
  error: string | null;
}

interface EmbedState {
  /** Model catalog with downloaded/active flags, for the picker panel. */
  models: EmbedModelInfo[];
  /** Lifecycle of the model being selected; null before any selection. */
  status: EmbedStatus | null;
  /** Indexing progress for the open folder; null when idle. */
  progress: { done: number; total: number } | null;
}

export const useEmbedStore = create<EmbedState>()(() => ({
  models: [],
  status: null,
  progress: null,
}));

async function refreshModels(): Promise<void> {
  const models = await api.embeddingModels();
  useEmbedStore.setState({ models });
  // After a webview reload the Rust side may still hold a loaded model; mirror it back.
  const active = models.find((m) => m.active);
  if (active && useEmbedStore.getState().status === null) {
    useEmbedStore.setState({ status: { modelId: active.id, phase: "ready", error: null } });
  }
}

/** Mirrors the Rust model lifecycle and indexing progress; once, at startup. */
export function startEmbeddings(): void {
  void events.embeddingStatus.listen(({ payload }) => {
    const phase = payload.phase;
    if (phase === "downloading" || phase === "loading" || phase === "ready" || phase === "error") {
      useEmbedStore.setState({ status: { modelId: payload.modelId, phase, error: payload.error } });
    }
    if (phase === "ready" || phase === "error") void refreshModels();
  });
  void events.embeddingProgress.listen(({ payload }) => {
    if (payload.epoch !== useAppStore.getState().epoch) return;
    useEmbedStore.setState({ progress: { done: payload.done, total: payload.total } });
  });
  let epoch = useAppStore.getState().epoch;
  useAppStore.subscribe((s) => {
    if (s.epoch === epoch) return;
    epoch = s.epoch;
    useEmbedStore.setState({ progress: null });
  });
  void refreshModels();
}
