import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FileEntry } from "../../ipc";
import { fileUrl, requestMeta, requestThumbnails } from "../../ipc";
import { hdrLabel } from "../../state/hdr";
import { hdrOf, selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import { parseNumber, Slider } from "../shell/Slider";
import { CropBadge, CroppedThumb } from "./CroppedThumb";
import { mosaicAspects, mosaicRows, packedOrder } from "./mosaic";

/**
 * The mosaic: the grid's photographs without the grid's empty space. Rows
 * are justified — every photograph keeps its own shape, scaled so each row
 * fills the width edge to edge — so the layout is all picture: no
 * letterboxing, no dead cell corners, no captions, and by default no gaps
 * either, a seamless wall of prints (the spacing slider adds air back for
 * whoever wants it). Names stay the grid's and the strip's job; here a
 * tooltip answers.
 */

const OVERSCAN_ROWS = 3;
const REQUEST_DEBOUNCE_MS = 50;

const ROW_MIN = 80;
const ROW_MAX = 360;

export function MosaicGallery() {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const status = useAppStore((s) => s.status);
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const allEntries = useAppStore((s) => s.entries);
  const meta = useAppStore((s) => s.meta);
  const crops = useAppStore((s) => s.crops);
  const rowPx = useAppStore((s) => s.mosaicRowPx);
  const setRowPx = useAppStore((s) => s.setMosaicRowPx);
  const packing = useAppStore((s) => s.mosaicPacking);
  const setPacking = useAppStore((s) => s.setMosaicPacking);
  const select = useAppStore((s) => s.select);
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  // Every photograph's shape comes from its metadata; ask once per folder
  // for whatever has not streamed in yet (the scenes view's pattern).
  useEffect(() => {
    if (status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [status, remote, allEntries, epoch]);

  // The display order: the sort's own, or repacked so every photograph
  // reads at (nearly) one scale. `order[displayPos]` is the index into the
  // visible list — the selection's coordinate system stays untouched.
  const { rows, order } = useMemo(() => {
    const aspects = mosaicAspects(entries, meta, crops);
    const order =
      packing === "packed" && rowPx > 0
        ? packedOrder(aspects, width / rowPx, 0)
        : aspects.map((_, i) => i);
    const shown = order.map((i) => aspects[i] ?? 1);
    return { rows: mosaicRows(shown, width, rowPx, 0), order };
  }, [entries, meta, crops, width, rowPx, packing]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rows[i]?.height ?? rowPx,
    overscan: OVERSCAN_ROWS,
  });

  // Row heights move with the pane, the slider and the streaming metadata;
  // the virtualizer caches measurements, so it has to be told.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rows]);

  // Keep the lead photograph on screen as the arrows walk the selection —
  // by its display position, which packing may have moved.
  useEffect(() => {
    if (selectedIndex === null) return;
    const pos = order.indexOf(selectedIndex);
    if (pos < 0) return;
    const at = rows.findIndex((r) => pos >= r.firstIndex && pos < r.firstIndex + r.count);
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "auto" });
  }, [selectedIndex, rows, order, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  // Ask Rust for thumbnails of the visible rows (debounced while scrolling).
  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs, thumbErrors } = useAppStore.getState();
      const wanted: string[] = [];
      for (let i = firstRow; i <= lastRow; i += 1) {
        const row = rows[i];
        if (row === undefined) continue;
        for (let pos = row.firstIndex; pos < row.firstIndex + row.count; pos += 1) {
          const e = entries[order[pos] ?? -1];
          if (e !== undefined && !(e.path in thumbs) && !(e.path in thumbErrors)) {
            wanted.push(e.path);
          }
        }
      }
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entries, rows, order, epoch, firstRow, lastRow]);

  return (
    <>
      <div className="gallery-toolbar">
        <Slider
          label="row height"
          value={rowPx}
          neutral={ROW_MIN}
          min={ROW_MIN}
          max={ROW_MAX}
          step={1}
          display={`${rowPx} px`}
          parse={parseNumber}
          ticks={[]}
          layout="inline"
          title="how tall the rows aim to be — each row then fills the width exactly"
          onChange={setRowPx}
        />
        <div className="develop-choices">
          <button
            className={packing === "order" ? "develop-choice on" : "develop-choice"}
            title="The sort's own order, row by row; rows vary a little in scale to fill the width."
            onClick={() => setPacking("order")}
          >
            as sorted
          </button>
          <button
            className={packing === "packed" ? "develop-choice on" : "develop-choice"}
            title="Every photograph at one scale: rows start in order but fill from the next few, so each comes out full without rescaling."
            onClick={() => setPacking("packed")}
          >
            one scale
          </button>
        </div>
      </div>
      {entries.length === 0 && <p className="hint">Nothing matches these filters.</p>}
      <div
        ref={scrollRef}
        className="gallery-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
      >
        <div
          className="gallery-inner"
          style={{ height: virtualizer.getTotalSize() }}
          onClick={(e) => {
            if (e.target === e.currentTarget) select(null);
          }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row === undefined) return null;
            return (
              <div
                key={virtualRow.key}
                className="mosaic-row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) select(null);
                }}
              >
                {Array.from({ length: row.count }, (_, i) => {
                  const index = order[row.firstIndex + i] ?? -1;
                  const entry = entries[index];
                  if (entry === undefined) return null;
                  return (
                    <MosaicCell
                      key={entry.path}
                      entry={entry}
                      index={index}
                      width={row.widths[i] ?? row.height}
                      height={row.height}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function MosaicCell({
  entry,
  index,
  width,
  height,
}: {
  entry: FileEntry;
  index: number;
  width: number;
  height: number;
}) {
  const cacheFile = useAppStore((s) => s.thumbs[entry.path]);
  const error = useAppStore((s) => s.thumbErrors[entry.path]);
  const selected = useAppStore((s) => s.selection.includes(entry.path));
  const lead = useAppStore((s) => s.selectedIndex === index);
  const stars = useAppStore((s) => s.labels[entry.path]?.stars ?? null);
  const openViewer = useAppStore((s) => s.openViewer);
  const hdr = useAppStore((s) => hdrOf(s).byFace.get(entry.path) ?? null);
  const crop = useAppStore((s) => s.crops[entry.path]);

  return (
    <button
      className={`mosaic-cell ${selected ? "selected" : ""} ${lead ? "lead" : ""}`}
      style={{ width, height }}
      title={entry.name}
      onClick={(e) => useAppStore.getState().selectAt(index, selectMode(e))}
      onDoubleClick={() => openViewer(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.getState().selectForMenu(index);
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
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
        // The cell already wears the display shape — the crop's when there
        // is one — so the cropped thumb fills it wall to wall.
        crop !== undefined ? (
          <CroppedThumb
            src={fileUrl(cacheFile)}
            alt={entry.name}
            crop={crop}
            frame={(width / height / crop.width) * crop.height}
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
    </button>
  );
}

function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([obsEntry]) => {
      if (obsEntry) setWidth(obsEntry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
