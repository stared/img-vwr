import type { FileEntry } from "../../ipc";
import { fileUrl } from "../../ipc";
import { hdrLabel } from "../../state/hdr";
import { hdrOf, selectMode, useAppStore } from "../../state/store";

interface ThumbCellProps {
  entry: FileEntry;
  index: number;
  size: number;
}

export function ThumbCell({ entry, index, size }: ThumbCellProps) {
  const cacheFile = useAppStore((s) => s.thumbs[entry.path]);
  const error = useAppStore((s) => s.thumbErrors[entry.path]);
  // Two marks, because they mean different things: every selected cell is
  // what an action reaches, and the lead is the one the panels describe.
  const selected = useAppStore((s) => s.selection.includes(entry.path));
  const lead = useAppStore((s) => s.selectedIndex === index);
  const stars = useAppStore((s) => s.labels[entry.path]?.stars ?? null);
  const openViewer = useAppStore((s) => s.openViewer);
  // The face of an HDR set wears the set's name: this cell is not one file
  // but the photograph fused from its bracket.
  const hdr = useAppStore((s) => hdrOf(s).byFace.get(entry.path) ?? null);

  return (
    <figure
      className={`thumb-cell ${selected ? "selected" : ""} ${lead ? "lead" : ""}`}
      style={{ width: size }}
      onClick={(e) => useAppStore.getState().selectAt(index, selectMode(e))}
      onDoubleClick={() => openViewer(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.getState().selectForMenu(index);
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="thumb-frame" style={{ height: size }}>
        {stars !== null && <span className="thumb-stars">{"★".repeat(stars)}</span>}
        {hdr !== null && (
          <span
            className="thumb-hdr"
            title={`${hdrLabel(hdr)} — this frame fronts the fused photograph; opening it shows the merge`}
          >
            HDR ×{hdr.frames.length}
          </span>
        )}
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
      {/* The file, named. The grid lists every file the camera wrote — a raw
          and its JPEG are two cells here, and the darkroom is where they
          become one photograph. */}
      <figcaption title={entry.path}>{entry.name}</figcaption>
    </figure>
  );
}
