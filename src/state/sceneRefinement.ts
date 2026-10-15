import { useEffect, useRef } from "react";

import { embeddingBandedScores, embeddingIndex } from "../ipc";
import { SCENE_BAND } from "./scenes";
import { useEmbedStore } from "./embeddings";
import { useAppStore, useVisibleEntries } from "./store";

/** Feeds scene grouping embedding similarities when a model is already loaded; without one, scenes stay time-only. */
export function useSceneRefinement(): void {
  const inScenes = useAppStore((s) => s.galleryLayout === "scenes");
  const localScope = useAppStore((s) => s.scope?.kind === "folder");
  const modelId = useEmbedStore((s) => (s.status?.phase === "ready" ? s.status.modelId : null));
  const indexing = useEmbedStore((s) => s.progress !== null && s.progress.done < s.progress.total);
  const epoch = useAppStore((s) => s.epoch);
  const visible = useVisibleEntries();
  const wanted = inScenes && localScope && modelId !== null;

  // Tracked in a ref, not derived from progress: indexing reports progress, so deriving re-fires a cached pass forever.
  const indexedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted) return;
    const key = `${epoch}:${modelId}`;
    if (indexedFor.current === key) return;
    indexedFor.current = key;
    void embeddingIndex(
      useAppStore.getState().entries.map((e) => e.path),
      epoch,
    );
  }, [wanted, epoch, modelId]);

  // Reading never causes progress, so this cannot loop.
  useEffect(() => {
    if (!wanted || indexing || visible.length < 2) return;
    let stale = false;
    embeddingBandedScores(
      visible.map((e) => e.path),
      SCENE_BAND,
    )
      .then((bands) => {
        if (!stale) useAppStore.getState().sceneSimsLoaded(visible, bands);
      })
      .catch(() => {
        // "No model loaded" and friends — scenes stay time-only.
      });
    return () => {
      stale = true;
    };
  }, [wanted, indexing, visible]);
}
