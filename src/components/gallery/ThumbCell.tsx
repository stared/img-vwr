import type { FileEntry } from "../../ipc";
import { fileUrl } from "../../ipc";
import { siblingsOf, stackCaption } from "../../state/stacks";
import { useAppStore } from "../../state/store";

interface ThumbCellProps {
  entry: FileEntry;
  index: number;
  size: number;
}

export function ThumbCell({ entry, index, size }: ThumbCellProps) {
  const cacheFile = useAppStore((s) => s.thumbs[entry.path]);
  const error = useAppStore((s) => s.thumbErrors[entry.path]);
  const selected = useAppStore((s) => s.selectedIndex === index);
  const stars = useAppStore((s) => s.labels[entry.path]?.stars ?? null);
  const openViewer = useAppStore((s) => s.openViewer);
  const stacking = useAppStore((s) => s.stacking);
  const allEntries = useAppStore((s) => s.entries);
  const caption = stacking ? stackCaption(entry, siblingsOf(allEntries, entry)) : entry.name;

  return (
    <figure
      className={`thumb-cell ${selected ? "selected" : ""}`}
      style={{ width: size }}
      onClick={() => useAppStore.getState().select(index)}
      onDoubleClick={() => openViewer(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.getState().select(index);
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="thumb-frame" style={{ height: size }}>
        {stars !== null && <span className="thumb-stars">{"★".repeat(stars)}</span>}
        {cacheFile !== undefined ? (
          <img src={fileUrl(cacheFile)} alt={entry.name} loading="lazy" draggable={false} />
        ) : error !== undefined ? (
          <span className="thumb-error" title={error}>
            ⚠
          </span>
        ) : (
          <span className="thumb-pending" />
        )}
      </div>
      {/* When a stack is collapsed, the caption says what else is in it —
          words on the caption the cell already has, rather than a badge that
          would have to be learned. */}
      <figcaption title={entry.path}>{caption}</figcaption>
    </figure>
  );
}
