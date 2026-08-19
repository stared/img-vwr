import type { FileEntry } from "../../ipc";
import { fileUrl } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { hdrLabel } from "../../state/hdr";
import { pairedName, siblingsOf } from "../../state/stacks";
import { hdrOf, selectMode, stacksCollapse, useAppStore } from "../../state/store";
import { CropBadge, CroppedThumb } from "./CroppedThumb";

interface ThumbCellProps {
  entry: FileEntry;
  index: number;
  size: number;
}

export function ThumbCell({ entry, index, size }: ThumbCellProps) {
  const cacheFile = useAppStore((s) => s.thumbs[entry.path]);
  const error = useAppStore((s) => s.thumbErrors[entry.path]);
  const selected = useAppStore((s) => s.selection.includes(entry.path));
  const lead = useAppStore((s) => s.selectedIndex === index);
  const stars = useAppStore((s) => s.labels[entry.path]?.stars ?? null);
  const openViewer = useAppStore((s) => s.openViewer);
  const hdr = useAppStore((s) => hdrOf(s).byFace.get(entry.path) ?? null);
  const crop = useAppStore((s) => s.crops[entry.path]);
  const meta = useAppStore((s) => s.meta[entry.path]);
  const dims = meta === undefined ? null : effectiveDims(meta);
  const caption = useAppStore((s) =>
    stacksCollapse(s)
      ? pairedName(entry, siblingsOf(s.entries, entry, hdrOf(s).keyByStack))
      : entry.name,
  );

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
        {crop !== undefined && <CropBadge />}
        {cacheFile !== undefined ? (
          crop !== undefined && dims !== null ? (
            <CroppedThumb
              src={fileUrl(cacheFile)}
              alt={entry.name}
              crop={crop}
              frame={dims.width / dims.height}
            />
          ) : (
            <img src={fileUrl(cacheFile)} alt={entry.name} loading="lazy" draggable={false} />
          )
        ) : error !== undefined ? (
          <span className="thumb-error" title={error}>
            ⚠
          </span>
        ) : (
          <span className="thumb-pending" />
        )}
      </div>
      <figcaption title={entry.path}>{caption}</figcaption>
    </figure>
  );
}
