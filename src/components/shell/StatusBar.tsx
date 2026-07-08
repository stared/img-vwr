import { useAppStore, useVisibleEntries } from "../../state/store";

export function StatusBar() {
  const scope = useAppStore((s) => s.scope);
  const total = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const index = useAppStore((s) => s.selectedIndex);
  const view = useAppStore((s) => s.viewerView);
  const img = useAppStore((s) => s.viewerImg);
  const visible = useVisibleEntries();
  const entry = visible[index];

  const countText =
    visible.length === total ? `${total} images` : `${visible.length} of ${total}`;

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
            <span>{entry.name}</span>
            <span>
              {index + 1} / {visible.length}
            </span>
            {img && (
              <span>
                {img.width}×{img.height}
              </span>
            )}
            {view && <span>{Math.round(view.scale * 100)}%</span>}
          </>
        ) : (
          total > 0 && <span>{countText}</span>
        )}
      </span>
    </footer>
  );
}
