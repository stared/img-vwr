import { useState } from "react";

import { embeddingSelect } from "../../ipc";
import { similarTo } from "../../similarity";
import { useAppStore } from "../../state/store";

function downloadLabel(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/**
 * Model picker + semantic search. Each model row carries its quality and
 * speed notes; picking one downloads it once into the app cache and loads
 * it. Everything runs locally.
 */
export function SimilarityPanel() {
  const models = useAppStore((s) => s.embedModels);
  const status = useAppStore((s) => s.embedStatus);
  const progress = useAppStore((s) => s.embedProgress);
  const scope = useAppStore((s) => s.scope);
  const [query, setQuery] = useState("");

  const ready = status?.phase === "ready";
  const busy = status?.phase === "downloading" || status?.phase === "loading";
  const localScope = scope?.kind === "folder";

  return (
    <div className="similarity">
      <p className="panel-hint">
        Sort by likeness — to an image, or to a phrase. A local model computes
        it; nothing leaves this machine.
      </p>

      <div className="model-list">
        {models.map((model) => {
          const inFlight = busy && status.modelId === model.id;
          const failed = status?.phase === "error" && status.modelId === model.id;
          const state = inFlight
            ? `${status.phase}…`
            : failed
              ? "failed"
              : model.active
                ? "active"
                : model.downloaded
                  ? "ready to load"
                  : `${downloadLabel(model.downloadMb)} download`;
          return (
            <button
              key={model.id}
              className={`model-row${model.active ? " active" : ""}`}
              disabled={busy || model.active}
              title={model.active ? `${model.label} is active` : `use ${model.label}`}
              onClick={() => void embeddingSelect(model.id)}
            >
              <span className="model-name">
                {model.label}
                <span className="model-state">{state}</span>
              </span>
              <span className="model-note">{model.quality}</span>
              <span className="model-note">{model.speed}</span>
            </button>
          );
        })}
      </div>

      {status?.phase === "error" && status.error && (
        <p className="panel-error">{status.error}</p>
      )}

      {ready && localScope && (
        <form
          className="source-form"
          onSubmit={(e) => {
            e.preventDefault();
            const text = query.trim();
            if (text) void similarTo({ kind: "text", query: text }, `"${text}"`);
          }}
        >
          <input
            value={query}
            placeholder="search by meaning…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      )}
      {ready && !localScope && (
        <p className="panel-hint">Open a local folder to search it by similarity.</p>
      )}

      {progress && progress.done < progress.total && (
        <p className="panel-hint">
          indexing {progress.done}/{progress.total}…
        </p>
      )}
    </div>
  );
}
