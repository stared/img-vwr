import {
  embeddingIndex,
  embeddingModels,
  embeddingRankImage,
  embeddingRankText,
  events,
} from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { registerFilterField } from "../registry/filters";
import { registerSort } from "../registry/sorts";
import { applyQuery } from "../state/query";
import type { Similarity } from "../state/store";
import { useAppStore } from "../state/store";

/**
 * Similarity module — the first consumer of the embedding plugin crate.
 * Registers the transient "closest" sort whose scores come from Rust (a
 * local dual-encoder model picked in the Similarity panel). The anchor is a
 * clause in the query bar — `closest to: "phrase" with <model>` — typed and
 * edited right there; commands cover the selected-image and palette flows.
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
  const models = await embeddingModels();
  const { setEmbedModels, setEmbedStatus, embedStatus } = useAppStore.getState();
  setEmbedModels(models);
  // After a webview reload the Rust side may still hold a loaded model;
  // mirror it back so the commands stay available.
  const active = models.find((m) => m.active);
  if (active && embedStatus === null) {
    setEmbedStatus({ modelId: active.id, phase: "ready", error: null });
  }
}

export function registerSimilarity(): void {
  registerSort({
    id: "similar",
    label: "closest",
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

  // The anchor is added like any other clause: "+ → closest to…" opens the
  // inline phrase input in the query bar.
  registerFilterField({
    id: "closest",
    label: "closest to…",
    appliesTo: (scope) => scope?.kind === "folder" && modelReady(),
    pick: () => useAppStore.getState().setClosestOpen(true),
  });

  registerCommand({
    id: "similar.image",
    title: "Closest to This Image",
    keywords: ["similar", "alike", "embedding", "nearest", "resembles"],
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
    title: "Closest to Phrase…",
    keywords: ["similar", "semantic", "describe", "embedding", "clip", "search by meaning"],
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
    // A newly loaded model measures a different space: recompute the anchor.
    if (phase === "ready") {
      const { similarity } = useAppStore.getState();
      if (similarity) void similarTo(similarity.anchor, similarity.label);
    }
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
