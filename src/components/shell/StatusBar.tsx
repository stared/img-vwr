import { TagDot } from "../../labels/TagDot";
import { pairedName, siblingsOf } from "../../state/stacks";
import { hdrOf, useAppStore, useSelectedEntry, useVisibleEntries } from "../../state/store";

export function StatusBar() {
  const scope = useAppStore((s) => s.scope);
  const status = useAppStore((s) => s.status);
  const total = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const galleryLayout = useAppStore((s) => s.galleryLayout);
  const index = useAppStore((s) => s.selectedIndex);
  const chosen = useAppStore((s) => s.selection.length);
  const img = useAppStore((s) => s.viewerImg);
  const visible = useVisibleEntries();
  const entry = useSelectedEntry();
  const labels = useAppStore((s) => (entry ? s.labels[entry.path] : undefined));
  const allEntries = useAppStore((s) => s.entries);
  const stacking = useAppStore((s) => s.stacking);
  const hdr = useAppStore((s) => hdrOf(s));
  const siblings = entry && stacking ? siblingsOf(allEntries, entry, hdr.keyByStack) : [];

  const looking = viewMode === "viewer" || galleryLayout === "darkroom";

  const totalText = status === "loading" ? `${total}…` : `${total}`;
  const countText =
    visible.length === total ? `${totalText} images` : `${visible.length} of ${totalText}`;
  const stars = labels?.stars ?? null;
  const tags = labels?.tags ?? [];

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
        {(stars !== null || tags.length > 0) && (
          <span className="status-labels">
            {stars !== null && <span className="status-stars">{"★".repeat(stars)}</span>}
            {tags.map((t) => (
              <span key={t}>
                <TagDot tag={t} />
                {t}
              </span>
            ))}
          </span>
        )}
        {entry && <span>{pairedName(entry, siblings)}</span>}
        {entry && chosen > 1 && (
          <button
            className="status-selected"
            title="Actions for the selection"
            onClick={(e) => useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY })}
          >
            {chosen} selected
          </button>
        )}
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
        {!entry && total > 0 && <span>{countText}</span>}
      </span>
    </footer>
  );
}
