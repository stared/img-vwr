import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { requestMeta, requestThumbnails } from "../../ipc";
import { groupScenes, sceneLabel, type Scene } from "../../state/scenes";
import { sceneSimsFor, useAppStore, useVisibleEntries } from "../../state/store";
import { ThumbCell } from "./ThumbCell";

const CELL_GAP = 8;
/* Must mirror the .thumb-cell CSS: padding, inner gap, fixed caption height. */
const CELL_PADDING = 4;
const CELL_INNER_GAP = 4;
const CAPTION_HEIGHT = 16;
const OVERSCAN_ROWS = 3;
const REQUEST_DEBOUNCE_MS = 50;

/* Must mirror the .gallery-scene-header CSS height. */
const SCENE_HEADER_HEIGHT = 28;

const MIN_CELL_PX = 96;
const MIN_COLUMNS = 2;

export function maxColumnsFor(width: number): number {
  if (width <= 0) return MIN_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.floor((width + CELL_GAP) / (MIN_CELL_PX + CELL_GAP)));
}

export function cellSizeFor(width: number, columns: number): number {
  const usable = width - CELL_GAP * (columns - 1);
  return Math.max(MIN_CELL_PX, Math.floor(usable / columns));
}

type GridRow =
  | { kind: "photos"; firstIndex: number; count: number }
  | { kind: "header"; label: string };

/** Index one visual row away (+1 down, -1 up), holding the column; null at the edge; headers skipped. */
export function rowNeighbor(
  rows: readonly GridRow[],
  index: number,
  direction: 1 | -1,
): number | null {
  const at = rows.findIndex(
    (r) => r.kind === "photos" && index >= r.firstIndex && index < r.firstIndex + r.count,
  );
  const from = rows[at];
  if (from === undefined || from.kind !== "photos") return null;
  for (let j = at + direction; j >= 0 && j < rows.length; j += direction) {
    const row = rows[j];
    if (row === undefined || row.kind !== "photos") continue;
    return row.firstIndex + Math.min(index - from.firstIndex, row.count - 1);
  }
  return null;
}

export function gridRows(
  entryCount: number,
  scenes: Scene[] | null,
  columns: number,
): GridRow[] {
  const rows: GridRow[] = [];
  if (scenes === null) {
    for (let i = 0; i < entryCount; i += columns) {
      rows.push({ kind: "photos", firstIndex: i, count: Math.min(columns, entryCount - i) });
    }
    return rows;
  }
  let previous: Scene | null = null;
  for (const scene of scenes) {
    rows.push({ kind: "header", label: sceneLabel(scene, previous, scene.end - scene.start) });
    for (let i = scene.start; i < scene.end; i += columns) {
      rows.push({ kind: "photos", firstIndex: i, count: Math.min(columns, scene.end - i) });
    }
    previous = scene;
  }
  return rows;
}

export function GalleryGrid({ grouped }: { grouped: boolean }) {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const status = useAppStore((s) => s.status);
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const allEntries = useAppStore((s) => s.entries);
  const preferredColumns = useAppStore((s) => s.gridColumns);
  const sceneGapMin = useAppStore((s) => s.sceneGapMin);
  const contentWeight = useAppStore((s) => s.sceneContentWeight);
  // Subscribed only when grouped: metadata streams in by the hundreds and would re-render the plain grid.
  const meta = useAppStore((s) => (grouped ? s.meta : null));
  const select = useAppStore((s) => s.select);
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  const maxColumns = maxColumnsFor(width);
  const columns = Math.min(Math.max(MIN_COLUMNS, preferredColumns), maxColumns);
  const cellSize = cellSizeFor(width, columns);
  const rowHeight = cellSize + CELL_INNER_GAP + CAPTION_HEIGHT + 2 * CELL_PADDING + CELL_GAP;

  // getState() keeps received meta out of the effect's deps, so streaming results don't re-fire the request.
  useEffect(() => {
    if (!grouped || status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [grouped, status, remote, allEntries, epoch]);

  const sceneSims = useAppStore((s) => (grouped ? s.sceneSims : null));
  const scenes = useMemo(
    () =>
      grouped
        ? groupScenes(
            entries,
            meta ?? {},
            sceneGapMin * 60_000,
            contentWeight,
            sceneSimsFor({ sceneSims }, entries),
          )
        : null,
    [grouped, entries, meta, sceneGapMin, contentWeight, sceneSims],
  );

  const rows = useMemo(
    () => gridRows(entries.length, scenes, columns),
    [entries.length, scenes, columns],
  );

  const setRowNavigator = useAppStore((s) => s.setRowNavigator);
  useEffect(() => {
    setRowNavigator((direction) => {
      const state = useAppStore.getState();
      if (state.selectedIndex === null) {
        state.navigate(direction);
        return;
      }
      const target = rowNeighbor(rows, state.selectedIndex, direction);
      if (target !== null) state.select(target);
    });
    return () => setRowNavigator(null);
  }, [rows, setRowNavigator]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? SCENE_HEADER_HEIGHT : rowHeight),
    overscan: OVERSCAN_ROWS,
  });

  // The virtualizer caches measurements; without measure() after height/kind changes it shows gaps.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight, rows]);

  useEffect(() => {
    if (selectedIndex === null) return;
    const at = rows.findIndex(
      (r) => r.kind === "photos" && selectedIndex >= r.firstIndex && selectedIndex < r.firstIndex + r.count,
    );
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "auto" });
  }, [selectedIndex, rows, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs, thumbErrors } = useAppStore.getState();
      const wanted: string[] = [];
      for (let i = firstRow; i <= lastRow; i += 1) {
        const row = rows[i];
        if (row === undefined || row.kind !== "photos") continue;
        for (const e of entries.slice(row.firstIndex, row.firstIndex + row.count)) {
          if (!(e.path in thumbs) && !(e.path in thumbErrors)) wanted.push(e.path);
        }
      }
      if (wanted.length > 0) {
        void requestThumbnails(wanted, epoch);
      }
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entries, rows, epoch, firstRow, lastRow]);

  const rowEntries = useMemo(
    () =>
      virtualRows.map((virtualRow) => ({
        virtualRow,
        gridRow: rows[virtualRow.index],
      })),
    [virtualRows, rows],
  );

  return (
    <>
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
          {rowEntries.map(({ virtualRow, gridRow }) =>
            gridRow === undefined ? null : gridRow.kind === "header" ? (
              <div
                key={virtualRow.key}
                className="gallery-scene-header"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {gridRow.label}
              </div>
            ) : (
              <div
                key={virtualRow.key}
                className="gallery-row"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  gridTemplateColumns: `repeat(${columns}, ${cellSize}px)`,
                  gap: CELL_GAP,
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) select(null);
                }}
              >
                {entries
                  .slice(gridRow.firstIndex, gridRow.firstIndex + gridRow.count)
                  .map((entry, i) => (
                    <ThumbCell
                      key={entry.path}
                      entry={entry}
                      index={gridRow.firstIndex + i}
                      size={cellSize}
                    />
                  ))}
              </div>
            ),
          )}
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
