import { embeddingSelect } from "../../ipc";
import { downloadLabel } from "../../similarity/ModelMenu";
import { useAppStore } from "../../state/store";

/**
 * Model picker for "closest to" sorting. Each row carries its quality and
 * speed notes; picking one downloads it once into the app cache and loads
 * it. Everything runs locally. The query itself lives in the filter bar:
 * `+ → closest to…`, or "Closest to This Image" on a selected image.
 */
export function SimilarityPanel() {
  const models = useAppStore((s) => s.embedModels);
  const status = useAppStore((s) => s.embedStatus);
  const progress = useAppStore((s) => s.embedProgress);

  const busy = status?.phase === "downloading" || status?.phase === "loading";

  return (
    <div className="similarity">
      <p className="panel-hint">
        Sort a folder by likeness — to an image, or to a phrase (sort: →
        closest to…). A local model computes it; nothing leaves this machine.
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

      {progress && progress.done < progress.total && (
        <p className="panel-hint">
          indexing {progress.done}/{progress.total}…
        </p>
      )}
    </div>
  );
}
