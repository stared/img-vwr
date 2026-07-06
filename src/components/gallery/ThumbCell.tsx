import type { FileEntry } from "../../ipc";
import { fileUrl } from "../../ipc";
import { useAppStore } from "../../state/store";

interface ThumbCellProps {
  entry: FileEntry;
  size: number;
}

export function ThumbCell({ entry, size }: ThumbCellProps) {
  const cacheFile = useAppStore((s) => s.thumbs[entry.path]);
  const error = useAppStore((s) => s.thumbErrors[entry.path]);

  return (
    <figure className="thumb-cell" style={{ width: size }}>
      <div className="thumb-frame" style={{ height: size }}>
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
