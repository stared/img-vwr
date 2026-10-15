import { create } from "zustand";

import { storeChannel } from "../../registry/channels";
import { defaultQuery } from "../../state/query";
import { leadPath, useAppStore, withQuery } from "../../state/store";

/** Computed per-image scores backing the transient "closest to …" sort. */
export interface Similarity {
  /** Chip value describing the anchor: a file name or a quoted phrase. */
  label: string;
  /** What the scores measure distance to; kept for re-ranking as the background index fills in. */
  anchor: { kind: "image"; path: string } | { kind: "text"; query: string };
  scores: Record<string, number>;
}

export const useSimilarityStore = create<{ similarity: Similarity | null }>()(() => ({
  similarity: null,
}));

const NO_SCORES: Readonly<Record<string, number>> = {};

/** path → closeness to the anchor; null until that photograph is scored. */
export const SCORES = storeChannel<{ similarity: Similarity | null }, number | null>(
  useSimilarityStore,
  (s) => s.similarity?.scores ?? NO_SCORES,
  null,
);

/** Install scores and switch the sort to "similar"; the lead is captured before the scores move it. */
export function setSimilarity(similarity: Similarity): void {
  const app = useAppStore.getState();
  // Streaming score updates must not reset a direction the user flipped.
  const current = app.query.sort;
  const dir = current.key === "similar" ? current.dir : "desc";
  const lead = leadPath(app);
  useSimilarityStore.setState({ similarity });
  const now = useAppStore.getState();
  useAppStore.setState(withQuery(now, { ...now.query, sort: { key: "similar", dir } }, lead));
}

export function clearSimilarity(): void {
  const app = useAppStore.getState();
  const sort = app.query.sort.key === "similar" ? defaultQuery.sort : app.query.sort;
  const lead = leadPath(app);
  useSimilarityStore.setState({ similarity: null });
  const now = useAppStore.getState();
  useAppStore.setState(withQuery(now, { ...now.query, sort }, lead));
}
