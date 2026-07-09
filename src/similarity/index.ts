import {
  embeddingIndex,
  embeddingModels,
  embeddingRankImage,
  embeddingRankText,
  events,
} from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { registerSort } from "../registry/sorts";
import { applyQuery } from "../state/query";
import type { Similarity } from "../state/store";
import { useAppStore } from "../state/store";

/**
 * Similarity module — the first consumer of the embedding plugin crate.
 * Registers a transient "similar" sort whose scores come from Rust (a local
 * dual-encoder model the user picks in the Similarity panel), plus the two
 * commands that set an anchor: the selected image, or a typed phrase.
 */

function inFolderScope(): boolean {
  return useAppStore.getState().scope?.kind === "folder";
}

function modelReady(): boolean {
  return useAppStore.getState().embedStatus?.phase === "ready";
}

/** Rank the whole collection against the anchor; unindexed images get no score. */
async function rankAnchor(anchor: Similarity["anchor"]): Promise<Record<string, number>> {
  const paths = useAppStore.getState().entries.map((e) => e.path);
  const ranked =
    anchor.kind === "image"
      ? await embeddingRankImage(anchor.path, paths)
      : await embeddingRankText(anchor.query, paths);
  const scores: Record<string, number> = {};
  for (const { path, score } of ranked) {
    scores[path] = score;
  }
  return scores;
}

/** Set (or refresh) the similarity anchor and make sure indexing is running. */
export async function similarTo(anchor: Similarity["anchor"], label: string): Promise<void> {
  const { entries, epoch, setSimilarity } = useAppStore.getState();
  // Fire-and-forget: vectors stream into the Rust cache; a completed pass
  // triggers a re-rank via the progress listener below.
  void embeddingIndex(
    entries.map((e) => e.path),
    epoch,
  );
  const scores = await rankAnchor(anchor);
  setSimilarity({ label, anchor, scores });
}

/** The image the user is on, within the current (query-applied) view. */
function selectedEntryPath(): { path: string; name: string } | null {
  const s = useAppStore.getState();
  const visible = applyQuery(s.entries, s.query, s.meta, s.similarity?.scores ?? {});
  const entry = visible[s.selectedIndex];
  return entry ? { path: entry.path, name: entry.name } : null;
}

async function refreshModels(): Promise<void> {
  useAppStore.getState().setEmbedModels(await embeddingModels());
}

export function registerSimilarity(): void {
  registerSort({
    id: "similar",
    label: "similar",
    hints: { asc: "least alike", desc: "closest first" },
    defaultDir: "desc",
    transient: true,
    needsScores: true,
    // Only local folders can be indexed, and the sort only means something
    // once an anchor has been chosen.
    appliesTo: (scope) =>
      scope?.kind === "folder" && useAppStore.getState().similarity !== null,
    value: (entry, ctx) => ctx.scores[entry.path] ?? null,
  });

  registerCommand({
    id: "similar.image",
    title: "Sort by Similarity to This Image",
    keywords: ["alike", "embedding", "nearest", "resembles"],
    when: (ctx: CommandContext) =>
      inFolderScope() && modelReady() && ctx.store.getState().entries.length > 0,
    run: async () => {
      const selected = selectedEntryPath();
      if (!selected) return;
      await similarTo({ kind: "image", path: selected.path }, selected.name);
    },
  });

  registerCommand({
    id: "similar.text",
    title: "Search by Meaning…",
    keywords: ["semantic", "phrase", "describe", "embedding", "clip"],
    input: { placeholder: "describe it, e.g. sunset over mountains" },
    when: (ctx: CommandContext) =>
      inFolderScope() && modelReady() && ctx.store.getState().entries.length > 0,
    run: async (_ctx, arg) => {
      const query = arg?.trim();
      if (!query) return;
      await similarTo({ kind: "text", query }, `"${query}"`);
    },
  });

  // Model lifecycle + indexing progress stream from Rust into the store.
  void events.embeddingStatus.listen(({ payload }) => {
    const phase = payload.phase;
    if (phase === "downloading" || phase === "loading" || phase === "ready" || phase === "error") {
      useAppStore.getState().setEmbedStatus({
        modelId: payload.modelId,
        phase,
        error: payload.error,
      });
    }
    // downloaded/active flags changed; refresh the picker.
    if (phase === "ready" || phase === "error") void refreshModels();
  });

  void events.embeddingProgress.listen(({ payload }) => {
    const { epoch, similarity, setEmbedProgress } = useAppStore.getState();
    if (payload.epoch !== epoch) return;
    setEmbedProgress({ done: payload.done, total: payload.total });
    // The pass finished: newly indexed images now deserve real scores.
    if (payload.done === payload.total && similarity) {
      void rankAnchor(similarity.anchor).then((scores) => {
        const current = useAppStore.getState().similarity;
        if (current && current.anchor === similarity.anchor) {
          useAppStore.getState().setSimilarity({ ...current, scores });
        }
      });
    }
  });

  void refreshModels();
}
