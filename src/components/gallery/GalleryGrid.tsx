import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { requestMeta, requestThumbnails } from "../../ipc";
import { groupScenes, sceneGapLabel, sceneLabel, type Scene } from "../../state/scenes";
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

/**
 * One virtual row: a run of cells, or a scene's header above its first run.
 * Descriptors only — the entries are sliced at render, so a scene change
 * costs row bookkeeping, never a copy of the collection.
 */
type GridRow =
  | { kind: "photos"; firstIndex: number; count: number }
  | { kind: "header"; label: string };

/** The rows the grid shows: plain runs, or scenes with their headers. */
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
    // Each scene starts its own row — the header marks a break in time, and
    // the break in the layout is what makes it readable at a glance.
    for (let i = scene.start; i < scene.end; i += columns) {
      rows.push({ kind: "photos", firstIndex: i, count: Math.min(columns, scene.end - i) });
    }
    previous = scene;
  }
  return rows;
}

export function GalleryGrid() {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const status = useAppStore((s) => s.status);
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const allEntries = useAppStore((s) => s.entries);
  const preferredColumns = useAppStore((s) => s.gridColumns);
  const setGridColumns = useAppStore((s) => s.setGridColumns);
  const sceneGapMin = useAppStore((s) => s.sceneGapMin);
  const cycleSceneGap = useAppStore((s) => s.cycleSceneGap);
  // Subscribed only while scenes are on — metadata streams in by the
  // hundreds, and a plain contact sheet has no business re-rendering for it.
  const meta = useAppStore((s) => (s.sceneGapMin === null ? null : s.meta));
  const select = useAppStore((s) => s.select);
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  const maxColumns = maxColumnsFor(width);
  const columns = Math.min(Math.max(MIN_COLUMNS, preferredColumns), maxColumns);
  const cellSize = cellSizeFor(width, columns);
  const rowHeight = cellSize + CELL_INNER_GAP + CAPTION_HEIGHT + 2 * CELL_PADDING + CELL_GAP;

  // Scene grouping wants when each photo was taken; ask once per folder for
  // whatever EXIF has not streamed in yet (same pattern as the stats panel —
  // getState() keeps in-flight paths from re-firing the request).
  useEffect(() => {
    if (sceneGapMin === null || status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [sceneGapMin, status, remote, allEntries, epoch]);

  const sceneSims = useAppStore((s) => (s.sceneGapMin === null ? null : s.sceneSims));
  const scenes = useMemo(
    () =>
      sceneGapMin === null
        ? null
        : groupScenes(
            entries,
            meta ?? {},
            sceneGapMin * 60_000,
            sceneSimsFor({ sceneSims }, entries),
          ),
    [entries, meta, sceneGapMin, sceneSims],
  );

  const rows = useMemo(
    () => gridRows(entries.length, scenes, columns),
    [entries.length, scenes, columns],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? SCENE_HEADER_HEIGHT : rowHeight),
    overscan: OVERSCAN_ROWS,
  });

  // Rows change height when the column count does, and change kind when
  // scenes come and go; the virtualizer caches measurements, so it has to be
  // told rather than left showing gaps.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight, rows]);

  // Keep the lead photograph on screen: stepping with the arrows — and
  // jumping by scene — must never walk the selection off the bottom.
  useEffect(() => {
    if (selectedIndex === null) return;
    const at = rows.findIndex(
      (r) => r.kind === "photos" && selectedIndex >= r.firstIndex && selectedIndex < r.firstIndex + r.count,
    );
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "auto" });
  }, [selectedIndex, rows, virtualizer]);

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
      <div className="gallery-toolbar">
        <button
          onClick={cycleSceneGap}
          title="group by pauses in shooting: a break longer than the gap starts a new scene"
        >
          {sceneGapLabel(sceneGapMin)}
        </button>
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
