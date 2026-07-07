import { defaultQuery } from "../../state/query";
import { useAppStore, useVisibleEntries } from "../../state/store";

const SORT_LABELS = { name: "name", modified: "modified", size: "size" } as const;

export function StatusBar() {
  const folderPath = useAppStore((s) => s.folderPath);
  const total = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const index = useAppStore((s) => s.selectedIndex);
  const sort = useAppStore((s) => s.query.sort);
  const view = useAppStore((s) => s.viewerView);
  const img = useAppStore((s) => s.viewerImg);
  const visible = useVisibleEntries();
  const entry = visible[index];

  const countText =
    visible.length === total ? `${total} images` : `${visible.length} of ${total}`;
  const sortIsDefault = sort.key === defaultQuery.sort.key && sort.dir === defaultQuery.sort.dir;

  return (
    <footer className="statusbar">
      <span className="status-path" title={folderPath ?? undefined}>
        {folderPath ?? "No folder open"}
      </span>
      <span className="status-right">
        {!sortIsDefault && (
          <span>
            {SORT_LABELS[sort.key]} {sort.dir === "asc" ? "↑" : "↓"}
          </span>
        )}
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
