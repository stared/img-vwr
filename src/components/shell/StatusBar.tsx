import { useAppStore, useSelectedEntry, useVisibleEntries } from "../../state/store";
import { zoomLabel } from "../viewer/viewport";

export function StatusBar() {
  const scope = useAppStore((s) => s.scope);
  const status = useAppStore((s) => s.status);
  const total = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const galleryLayout = useAppStore((s) => s.galleryLayout);
  const index = useAppStore((s) => s.selectedIndex);
  const chosen = useAppStore((s) => s.selection.length);
  const view = useAppStore((s) => s.viewerView);
  const fitted = useAppStore((s) => s.viewerFitted);
  const img = useAppStore((s) => s.viewerImg);
  const visible = useVisibleEntries();
  const entry = useSelectedEntry();
  const labels = useAppStore((s) => (entry ? s.labels[entry.path] : undefined));

  // Zoom and pixel size describe a viewport, so they belong wherever one is
  // on screen — the viewer and the darkroom both — and nowhere else.
  const looking = viewMode === "viewer" || galleryLayout === "darkroom";

  // While a scan streams in, the total is a running count, not a final one.
  const totalText = status === "loading" ? `${total}…` : `${total}`;
  const countText =
    visible.length === total ? `${totalText} images` : `${visible.length} of ${totalText}`;
  const labelsText = labels
    ? [labels.stars === null ? "" : "★".repeat(labels.stars), ...labels.tags]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <footer className="statusbar">
      <span className="status-path" title={scope?.kind === "source" ? scope.arg : scope?.path}>
        {scope === null
          ? "No folder open"
          : scope.kind === "folder"
            ? scope.path
            : `${scope.sourceId} · ${scope.label}`}
      </span>
      <span className="status-right">
        {labelsText && <span className="status-labels">{labelsText}</span>}
        {/* Which file is being looked at, wherever there is one. It used to
            appear only in the full-screen viewer, which left the darkroom —
            the view built for working on one photograph — as the one place
            that never said which photograph. */}
        {entry && <span>{entry.name}</span>}
        {/* Where you are in the sequence — or, once more than one photograph
            is picked, how many an action would reach. The second is the more
            urgent fact: it is what "delete" is about to mean. */}
        {entry && chosen > 1 && <span>{chosen} selected</span>}
        {entry && chosen <= 1 && (
          <span>
            {(index ?? 0) + 1} / {visible.length}
          </span>
        )}
        {looking && img && (
          <span>
            {img.width}×{img.height}
          </span>
        )}
        {/* In the same words as the zoom bar and the corner marker: "fit"
            is a named state, not a percentage that happens to equal it. */}
        {looking && view && <span>{zoomLabel(view, fitted)}</span>}
        {!entry && total > 0 && <span>{countText}</span>}
      </span>
    </footer>
  );
}
