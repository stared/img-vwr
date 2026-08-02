import { useAppStore, useSelectedEntry, useVisibleEntries } from "../../state/store";

export function StatusBar() {
  const scope = useAppStore((s) => s.scope);
  const status = useAppStore((s) => s.status);
  const total = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const index = useAppStore((s) => s.selectedIndex);
  const view = useAppStore((s) => s.viewerView);
  const img = useAppStore((s) => s.viewerImg);
  const visible = useVisibleEntries();
  const entry = useSelectedEntry();
  const labels = useAppStore((s) => (entry ? s.labels[entry.path] : undefined));

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
        {viewMode === "viewer" && entry ? (
          <>
            {labelsText && <span className="status-labels">{labelsText}</span>}
            <span>{entry.name}</span>
            <span>
              {(index ?? 0) + 1} / {visible.length}
            </span>
            {img && (
              <span>
                {img.width}×{img.height}
              </span>
            )}
            {view && <span>{Math.round(view.scale * 100)}%</span>}
          </>
        ) : (
          <>
            {labelsText && <span className="status-labels">{labelsText}</span>}
            {total > 0 && <span>{countText}</span>}
          </>
        )}
      </span>
    </footer>
  );
}
