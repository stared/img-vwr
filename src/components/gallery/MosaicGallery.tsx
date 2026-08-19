import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FileEntry } from "../../ipc";
import { fileUrl, requestMeta, requestThumbnails } from "../../ipc";
import { hdrLabel } from "../../state/hdr";
import { hdrOf, selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import { CropBadge, CroppedThumb } from "./CroppedThumb";
import { bandedMosaic, mosaicAspects, mosaicRows, rowsToBands, verticalNeighbor } from "./mosaic";

const OVERSCAN_ROWS = 3;
const REQUEST_DEBOUNCE_MS = 50;

export function MosaicGallery() {
  const entries = useVisibleEntries();
  const epoch = useAppStore((s) => s.epoch);
  const status = useAppStore((s) => s.status);
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const allEntries = useAppStore((s) => s.entries);
  const meta = useAppStore((s) => s.meta);
  const crops = useAppStore((s) => s.crops);
  const rowPx = useAppStore((s) => s.mosaicRowPx);
  const packing = useAppStore((s) => s.mosaicPacking);
  const select = useAppStore((s) => s.select);
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(scrollRef);

  // getState() keeps received meta out of the effect's deps, so streaming results don't re-fire the request.
  useEffect(() => {
    if (status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [status, remote, allEntries, epoch]);

  const bands = useMemo(() => {
    const aspects = mosaicAspects(entries, meta, crops);
    return packing === "packed" && rowPx > 0
      ? bandedMosaic(aspects, width, rowPx)
      : rowsToBands(mosaicRows(aspects, width, rowPx, 0));
  }, [entries, meta, crops, width, rowPx, packing]);

  const setRowNavigator = useAppStore((s) => s.setRowNavigator);
  useEffect(() => {
    setRowNavigator((direction) => {
      const state = useAppStore.getState();
      if (state.selectedIndex === null) {
        state.navigate(direction);
        return;
      }
      const target = verticalNeighbor(bands, state.selectedIndex, direction);
      if (target !== null) state.select(target);
    });
    return () => setRowNavigator(null);
  }, [bands, setRowNavigator]);

  const virtualizer = useVirtualizer({
    count: bands.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => bands[i]?.height ?? rowPx,
    overscan: OVERSCAN_ROWS,
  });

  // The virtualizer caches measurements; without measure() after band-height changes it shows gaps.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, bands]);

  useEffect(() => {
    if (selectedIndex === null) return;
    const at = bands.findIndex((b) => b.cells.some((c) => c.index === selectedIndex));
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "auto" });
  }, [selectedIndex, bands, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  const firstBand = virtualRows[0]?.index ?? 0;
  const lastBand = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs, thumbErrors } = useAppStore.getState();
      const wanted: string[] = [];
      for (let i = firstBand; i <= lastBand; i += 1) {
        for (const cell of bands[i]?.cells ?? []) {
          const e = entries[cell.index];
          if (e !== undefined && !(e.path in thumbs) && !(e.path in thumbErrors)) {
            wanted.push(e.path);
          }
        }
      }
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entries, bands, epoch, firstBand, lastBand]);

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
          {virtualRows.map((virtualRow) => {
            const band = bands[virtualRow.index];
            if (band === undefined) return null;
            return (
              <div
                key={virtualRow.key}
                className="mosaic-row"
                style={{ transform: `translateY(${virtualRow.start}px)`, height: band.height }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) select(null);
                }}
              >
                {band.cells.map((cell) => {
                  const entry = entries[cell.index];
                  if (entry === undefined) return null;
                  return (
                    <MosaicCell
                      key={entry.path}
                      entry={entry}
                      index={cell.index}
                      x={cell.x}
                      y={cell.y}
                      width={cell.width}
                      height={cell.height}
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
  x,
  y,
  width,
  height,
}: {
  entry: FileEntry;
  index: number;
  x: number;
  y: number;
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
      style={{ left: x, top: y, width, height }}
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
        // The cell's shape is already the crop's, so the frame aspect is recovered by inverting croppedBoxRatio.
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
