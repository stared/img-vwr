import type { FileEntry } from "../../ipc";
import { fileUrl } from "../../ipc";
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

  return (
    <figure
      className={`thumb-cell ${selected ? "selected" : ""}`}
      style={{ width: size }}
      onClick={() => useAppStore.setState({ selectedIndex: index })}
      onDoubleClick={() => openViewer(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.setState({ selectedIndex: index });
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
      <figcaption title={entry.name}>{entry.name}</figcaption>
    </figure>
  );
}
