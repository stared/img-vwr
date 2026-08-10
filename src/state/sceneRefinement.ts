import { useEffect, useRef } from "react";

import { embeddingBandedScores, embeddingIndex } from "../ipc";
import { SCENE_BAND } from "./scenes";
import { useAppStore, useVisibleEntries } from "./store";

/**
 * Feeds scene grouping its embedding similarities, when there are any to
 * have.
 *
 * The clock alone draws good scene boundaries; this makes them better where
 * an embedding model is already loaded — the same model the Similarity
 * panel uses. When scenes are on and the model is ready, the collection is
 * indexed (a cached pass is instant) and the consecutive-pair scores land
 * in the store, where grouping picks them up. No model, or none loaded:
 * nothing happens, and scenes stay time-only. The refinement is an upgrade
 * that arrives, never a dependency that blocks.
 */
export function useSceneRefinement(): void {
  const inScenes = useAppStore((s) => s.galleryLayout === "scenes");
  const localScope = useAppStore((s) => s.scope?.kind === "folder");
  const modelId = useAppStore((s) =>
    s.embedStatus?.phase === "ready" ? s.embedStatus.modelId : null,
  );
  const indexing = useAppStore(
    (s) => s.embedProgress !== null && s.embedProgress.done < s.embedProgress.total,
  );
  const epoch = useAppStore((s) => s.epoch);
  const visible = useVisibleEntries();
  const wanted = inScenes && localScope && modelId !== null;

  // Ask for indexing once per (folder, model) — remembered in a ref, NOT
  // derived from progress. The pass itself reports progress, so an effect
  // that both watches progress and requests indexing chases its own tail:
  // every completed (fully cached, instant) pass re-fires it, forever.
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

  // Read whatever scores exist whenever indexing is quiet. A pass that ran
  // flips `indexing` on its way through, so completion lands here once and
  // the scores converge to full coverage without polling. Reading never
  // causes progress, so this cannot loop.
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
