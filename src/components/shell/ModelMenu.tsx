import { embeddingSelect } from "../../ipc";
import { useEmbedStore } from "../../state/embeddings";

export function downloadLabel(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** Selecting downloads/loads the model; the re-rank arrives via the embedding status listener. */
export function ModelMenu({ close }: { close: () => void }) {
  const models = useEmbedStore((s) => s.models);
  const status = useEmbedStore((s) => s.status);
  const busy = status?.phase === "downloading" || status?.phase === "loading";
  return (
    <>
      {models.map((model) => (
        <button
          key={model.id}
          disabled={busy || model.active}
          onClick={() => {
            void embeddingSelect(model.id);
            close();
          }}
        >
          {model.label}
          <span className="menu-hint">
            {busy && status.modelId === model.id
              ? `${status.phase}…`
              : model.active
                ? ""
                : model.downloaded
                  ? "ready"
                  : downloadLabel(model.downloadMb)}
          </span>
          <span className="menu-check">{model.active ? "✓" : ""}</span>
        </button>
      ))}
    </>
  );
}
