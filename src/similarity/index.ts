import {
  embeddingIndex,
  embeddingModels,
  embeddingRankImage,
  embeddingRankText,
  embeddingSelect,
  events,
} from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { registerSort } from "../registry/sorts";
import type { Similarity } from "../state/store";
import { useAppStore, visibleOf } from "../state/store";
import { ModelMenu } from "./ModelMenu";

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

/** Monotonic guard: a slow rank response must never overwrite a newer one. */
let rankSeq = 0;

/** Swallows rank failures: this runs from event listeners where a model switch mid-flight ordinarily fails, and the next batch re-ranks anyway. */
async function refreshScores(anchor: Similarity["anchor"]): Promise<void> {
  const seq = ++rankSeq;
  let scores: Record<string, number>;
  try {
    scores = await rankAnchor(anchor);
  } catch (error) {
    console.warn("ranking failed; keeping the current order", error);
    return;
  }
  const current = useAppStore.getState().similarity;
  if (seq === rankSeq && current !== null && current.anchor === anchor) {
    useAppStore.getState().setSimilarity({ ...current, scores });
  }
}

/** Set (or refresh) the similarity anchor and make sure indexing is running. */
export async function similarTo(anchor: Similarity["anchor"], label: string): Promise<void> {
  const { entries, epoch, setSimilarity } = useAppStore.getState();
  void embeddingIndex(
    entries.map((e) => e.path),
    epoch,
  );
  // Empty scores first: the old anchor's order must never show under the new label.
  setSimilarity({ label, anchor, scores: {} });
  await refreshScores(anchor);
}

/** Never auto-downloads: with no model on disk it opens the picker instead. */
async function anchorTo(anchor: Similarity["anchor"], label: string): Promise<void> {
  if (modelReady()) {
    await similarTo(anchor, label);
    return;
  }
  const { embedModels, setSimilarity, setActivePanel } = useAppStore.getState();
  setSimilarity({ label, anchor, scores: {} });
  const downloaded = embedModels.find((m) => m.downloaded);
  if (downloaded) await embeddingSelect(downloaded.id);
  else setActivePanel("similarity");
}

function selectedEntryPath(): { path: string; name: string } | null {
  const s = useAppStore.getState();
  if (s.selectedIndex === null) return null;
  const visible = visibleOf(s, s.query);
  const entry = visible[s.selectedIndex];
  return entry ? { path: entry.path, name: entry.name } : null;
}

async function refreshModels(): Promise<void> {
  const models = await embeddingModels();
  const { setEmbedModels, setEmbedStatus, embedStatus } = useAppStore.getState();
  setEmbedModels(models);
  // After a webview reload the Rust side may still hold a loaded model; mirror it back.
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
    appliesTo: (scope) => scope?.kind === "folder",
    reads: "scores",
    missing: "hide",
    param: {
      segments: () => {
        const { similarity, embedModels, embedStatus } = useAppStore.getState();
        const busy =
          embedStatus?.phase === "downloading" || embedStatus?.phase === "loading";
        const model = busy
          ? `${embedStatus.phase}…`
          : (embedModels.find((m) => m.active)?.label ?? "no model");
        return [
          { kind: "text", text: "closest to" },
          {
            kind: "edit",
            text: similarity === null ? "…" : similarity.label,
            prefill: similarity?.anchor.kind === "text" ? similarity.anchor.query : "",
            placeholder: "describe it…",
            commit: (value) => {
              const query = value.trim();
              if (query) void anchorTo({ kind: "text", query }, `"${query}"`);
            },
          },
          { kind: "text", text: "with" },
          { kind: "menu", text: model, Menu: ModelMenu },
        ];
      },
      collectLabel: "closest to…",
      collectHint: "type a phrase",
      isSet: () => useAppStore.getState().similarity !== null,
      clear: () => useAppStore.getState().clearSimilarity(),
    },
    value: (entry, ctx) => ctx.scores[entry.path] ?? null,
  });

  registerCommand({
    id: "similar.image",
    title: "Find Similar",
    keywords: ["similar", "alike", "closest", "embedding", "nearest", "resembles"],
    menus: [{ menu: "image", section: "open", submenu: null, label: "Find Similar" }],
    when: (ctx: CommandContext) => inFolderScope() && ctx.store.getState().entries.length > 0,
    run: async () => {
      const selected = selectedEntryPath();
      if (!selected) return;
      await anchorTo({ kind: "image", path: selected.path }, selected.name);
    },
  });

  registerCommand({
    id: "similar.text",
    title: "Closest to Phrase…",
    keywords: ["similar", "semantic", "describe", "embedding", "clip", "search by meaning"],
    input: { placeholder: "describe it, e.g. sunset over mountains" },
    menus: [],
    when: (ctx: CommandContext) => inFolderScope() && ctx.store.getState().entries.length > 0,
    run: async (_ctx, arg) => {
      const query = arg?.trim();
      if (!query) return;
      await anchorTo({ kind: "text", query }, `"${query}"`);
    },
  });

  void events.embeddingStatus.listen(({ payload }) => {
    const phase = payload.phase;
    if (phase === "downloading" || phase === "loading" || phase === "ready" || phase === "error") {
      useAppStore.getState().setEmbedStatus({
        modelId: payload.modelId,
        phase,
        error: payload.error,
      });
    }
    if (phase === "ready" || phase === "error") void refreshModels();
    // A newly loaded model's scores are not comparable to the old one's: recompute the anchor.
    if (phase === "ready") {
      const { similarity } = useAppStore.getState();
      if (similarity) void similarTo(similarity.anchor, similarity.label);
    }
  });

  void events.embeddingProgress.listen(({ payload }) => {
    const { epoch, similarity, setEmbedProgress } = useAppStore.getState();
    if (payload.epoch !== epoch) return;
    setEmbedProgress({ done: payload.done, total: payload.total });
    if (similarity) void refreshScores(similarity.anchor);
  });

  void refreshModels();
}
