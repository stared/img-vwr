import { useAppStore } from "../../state/store";

export function StatusBar() {
  const folderPath = useAppStore((s) => s.folderPath);
  const count = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const index = useAppStore((s) => s.selectedIndex);
  const entry = useAppStore((s) => s.entries[s.selectedIndex]);
  const view = useAppStore((s) => s.viewerView);
  const img = useAppStore((s) => s.viewerImg);

  return (
    <footer className="statusbar">
      <span className="status-path" title={folderPath ?? undefined}>
        {folderPath ?? "No folder open"}
      </span>
      {viewMode === "viewer" && entry ? (
        <span className="status-right">
          <span>{entry.name}</span>
          <span>
            {index + 1} / {count}
          </span>
          {img && (
            <span>
              {img.width}×{img.height}
            </span>
          )}
          {view && <span>{Math.round(view.scale * 100)}%</span>}
        </span>
      ) : (
        <span className="status-right">{count > 0 && <span>{count} images</span>}</span>
      )}
    </footer>
  );
}
