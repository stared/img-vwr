import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { requestThumbnails } from "../../ipc";
import { useAppStore, useVisibleEntries } from "../../state/store";
import { ThumbCell } from "./ThumbCell";

const CELL_GAP = 8;
/* Must mirror the .thumb-cell CSS: padding, inner gap, fixed caption height. */
const CELL_PADDING = 4;
const CELL_INNER_GAP = 4;
const CAPTION_HEIGHT = 16;
const OVERSCAN_ROWS = 3;
const REQUEST_DEBOUNCE_MS = 50;

/** Below this a thumbnail stops being a picture, so it bounds the column count. */
const MIN_CELL_PX = 96;
const MIN_COLUMNS = 2;

/** Widest column count worth offering at this width — a viewport-relative
 * limit rather than an arbitrary one, so the slider always ends somewhere
 * that still shows photographs. */
export function maxColumnsFor(width: number): number {
  if (width <= 0) return MIN_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.floor((width + CELL_GAP) / (MIN_CELL_PX + CELL_GAP)));
}

/** Cell edge that makes `columns` of them exactly fill the width. */
export function cellSizeFor(width: number, columns: number): number {
  const usable = width - CELL_GAP * (columns - 1);
  return Math.max(MIN_CELL_PX, Math.floor(usable / columns));
}

export function GalleryGrid() {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const preferredColumns = useAppStore((s) => s.gridColumns);
  const setGridColumns = useAppStore((s) => s.setGridColumns);
  const select = useAppStore((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  const maxColumns = maxColumnsFor(width);
  const columns = Math.min(Math.max(MIN_COLUMNS, preferredColumns), maxColumns);
  const cellSize = cellSizeFor(width, columns);
  const rowHeight = cellSize + CELL_INNER_GAP + CAPTION_HEIGHT + 2 * CELL_PADDING + CELL_GAP;
  const rowCount = Math.ceil(entries.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
  });

  // Rows change height when the column count does; the virtualizer caches
  // measurements, so it has to be told rather than left showing gaps.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const virtualRows = virtualizer.getVirtualItems();

  // Ask Rust for thumbnails of the visible rows (debounced while scrolling).
  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs, thumbErrors } = useAppStore.getState();
      const wanted = entries
        .slice(firstRow * columns, (lastRow + 1) * columns)
        .map((e) => e.path)
        .filter((path) => !(path in thumbs) && !(path in thumbErrors));
      if (wanted.length > 0) {
        void requestThumbnails(wanted, epoch);
      }
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entries, epoch, columns, firstRow, lastRow]);

  const rowEntries = useMemo(
    () =>
      virtualRows.map((row) => ({
        row,
        firstIndex: row.index * columns,
        items: entries.slice(row.index * columns, (row.index + 1) * columns),
      })),
    [virtualRows, entries, columns],
  );

  return (
    <>
      <div className="gallery-toolbar">
        <label className="gallery-size" title="how many photos fill a row">
          <input
            type="range"
            min={MIN_COLUMNS}
            max={maxColumns}
            step={1}
            value={columns}
            onChange={(e) => setGridColumns(Number(e.currentTarget.value))}
          />
          {columns} per row
        </label>
      </div>
      <div
        ref={scrollRef}
        className="gallery-scroll"
        // Clicking past the last thumbnail, or in the gaps, means "none of
        // these" — the counterpart to Esc.
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
          {rowEntries.map(({ row, firstIndex, items }) => (
            <div
              key={row.key}
              className="gallery-row"
              style={{
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columns}, ${cellSize}px)`,
                gap: CELL_GAP,
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) select(null);
              }}
            >
              {items.map((entry, i) => (
                <ThumbCell key={entry.path} entry={entry} index={firstIndex + i} size={cellSize} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
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
