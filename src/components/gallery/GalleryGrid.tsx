import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { requestThumbnails } from "../../ipc";
import { useAppStore, useVisibleEntries } from "../../state/store";
import { ThumbCell } from "./ThumbCell";

const CELL_SIZE = 168;
const CELL_GAP = 8;
/* Must mirror the .thumb-cell CSS: padding, inner gap, fixed caption height. */
const CELL_PADDING = 4;
const CELL_INNER_GAP = 4;
const CAPTION_HEIGHT = 16;
const ROW_HEIGHT =
  CELL_SIZE + CELL_INNER_GAP + CAPTION_HEIGHT + 2 * CELL_PADDING + CELL_GAP;
const OVERSCAN_ROWS = 3;
const REQUEST_DEBOUNCE_MS = 50;

export function GalleryGrid() {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  const columns = Math.max(1, Math.floor((width + CELL_GAP) / (CELL_SIZE + CELL_GAP)));
  const rowCount = Math.ceil(entries.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  });

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
    <div ref={scrollRef} className="gallery-scroll">
      <div className="gallery-inner" style={{ height: virtualizer.getTotalSize() }}>
        {rowEntries.map(({ row, firstIndex, items }) => (
          <div
            key={row.key}
            className="gallery-row"
            style={{
              transform: `translateY(${row.start}px)`,
              gridTemplateColumns: `repeat(${columns}, ${CELL_SIZE}px)`,
              gap: CELL_GAP,
            }}
          >
            {items.map((entry, i) => (
              <ThumbCell key={entry.path} entry={entry} index={firstIndex + i} size={CELL_SIZE} />
            ))}
          </div>
        ))}
      </div>
    </div>
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
