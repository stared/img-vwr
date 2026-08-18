import { useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "../../ipc";
import { fileUrl, requestThumbnails } from "../../ipc";
import { takenMs } from "../../state/derived";
import { selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import type { TimeWindow } from "./timeline";
import { fitWindow, packLanes, packSpan, pannedWindow, timeTicks, zoomedWindow } from "./timeline";

/**
 * The gallery as a timeline: every visible entry sits on a time axis at its
 * date taken (EXIF; falls back to modified). Photos never overlap — one
 * landing on an occupied stretch shifts a lane further from the axis. The
 * axis runs vertically or horizontally (labeled toggle); wheel (or drag)
 * pans along time, ⌘/ctrl+wheel zooms around the cursor. The size slider
 * changes only how large the photos draw — the time window stays put; the
 * photos re-pack into lanes at their new size. Time is a pan/zoom window,
 * not a scrollable canvas — a deeply zoomed year is more pixels than an
 * element can be.
 */

const LANE_GAP = 6;
/** Room for the axis line and its date labels. */
const GUTTER = 76;
/** Edge of the cached thumbnails (Rust THUMB_MAX_EDGE). */
const THUMB_SOURCE_EDGE = 256;
const OVERSCAN_PX = 200;
const REQUEST_DEBOUNCE_MS = 50;

interface TimedItem {
  entry: FileEntry;
  /** Index into the visible (query-applied) list, for selection. */
  index: number;
  t: number;
  /** True when the time is EXIF date-taken, false for modified fallback. */
  taken: boolean;
}

export function TimelineGallery() {
  const entries = useVisibleEntries();
  const meta = useAppStore((s) => s.meta);
  const epoch = useAppStore((s) => s.epoch);
  const vertical = useAppStore((s) => s.timelineOrientation === "vertical");
  const thumbPref = useAppStore((s) => s.timelineThumbPx);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ main: 0, cross: 0 });
  /** Cross-axis scroll offset (native); the main axis is the time window. */
  const [crossScroll, setCrossScroll] = useState(0);
  const [win, setWin] = useState<TimeWindow | null>(null); // null = fit all

  const timed: TimedItem[] = useMemo(
    () =>
      entries
        .map((entry, index) => {
          const m = meta[entry.path];
          const taken = m ? takenMs(m) : null;
          return { entry, index, t: taken ?? entry.modifiedMs, taken: taken !== null };
        })
        .sort((a, b) => a.t - b.t),
    [entries, meta],
  );
  const tMin = timed[0]?.t ?? 0;
  const tMax = timed[timed.length - 1]?.t ?? 0;

  // A new scope, or a rotated axis, starts back at the full range.
  useEffect(() => setWin(null), [epoch, vertical]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setViewSize({
        main: vertical ? el.clientHeight : el.clientWidth,
        cross: vertical ? el.clientWidth : el.clientHeight,
      });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [vertical]);

  const fit = fitWindow(tMin, tMax, viewSize.main);
  const view = win ?? fit;

  // Photos may grow to about half the viewport across the lanes.
  const thumbMax = Math.max(120, Math.round(viewSize.cross / 2));
  const thumb = Math.min(thumbPref, thumbMax);
  const lane = thumb + LANE_GAP;

  const ts = useMemo(() => timed.map((i) => i.t), [timed]);

  // Lane packing spans the whole collection, so lanes are stable while
  // panning. The span is snapped to a log grid: a continuous pinch re-packs
  // only on crossing a grid step, not on every wheel event.
  const spanMs = packSpan(lane * view.msPerPx);
  const packed = useMemo(() => packLanes(ts, spanMs), [ts, spanMs]);

  // Wheel: plain = pan along time, ⌘/ctrl (and trackpad pinch) = zoom at
  // the cursor. Native listener — React's is passive, preventDefault needs this.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const alongMain = vertical ? e.clientY - rect.top : e.clientX - rect.left;
      const viewPx = vertical ? el.clientHeight : el.clientWidth;
      if (e.ctrlKey || e.metaKey) {
        // Clamp one event's zoom: a mouse-wheel notch reports ±120, which
        // raw would jump 3.3x — cap it near the trackpad's smooth range.
        const factor = Math.exp(Math.max(-40, Math.min(40, e.deltaY)) * 0.01);
        setWin((w) =>
          replaceWin(w, zoomedWindow(w ?? fitWindow(tMin, tMax, viewPx), factor, alongMain, tMin, tMax, viewPx)),
        );
      } else {
        const mainDelta = vertical ? e.deltaY : e.deltaX || e.deltaY;
        const crossDelta = vertical ? e.deltaX : e.deltaX ? e.deltaY : 0;
        setWin((w) =>
          replaceWin(w, pannedWindow(w ?? fitWindow(tMin, tMax, viewPx), mainDelta, tMin, tMax, viewPx)),
        );
        if (crossDelta !== 0) {
          if (vertical) el.scrollLeft += crossDelta;
          else el.scrollTop += crossDelta;
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vertical, tMin, tMax]);

  // Drag anywhere on the background pans time (and the lanes, natively).
  const drag = useRef<{ main: number; cross: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tl-item")) return;
    drag.current = { main: vertical ? e.clientY : e.clientX, cross: vertical ? e.clientX : e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const start = drag.current;
    const el = scrollRef.current;
    if (!start || !el) return;
    const main = vertical ? e.clientY : e.clientX;
    const cross = vertical ? e.clientX : e.clientY;
    setWin((w) => replaceWin(w, pannedWindow(w ?? fit, start.main - main, tMin, tMax, viewSize.main)));
    if (vertical) el.scrollLeft += start.cross - cross;
    else el.scrollTop += start.cross - cross;
    drag.current = { main, cross };
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const mainPx = (t: number) => (t - view.t0) / view.msPerPx;

  // Only the window (± overscan) renders; `timed` is time-sorted, so the
  // main-axis slice is a binary search.
  const tA = view.t0 - (OVERSCAN_PX + lane) * view.msPerPx;
  const tB = view.t0 + (viewSize.main + OVERSCAN_PX) * view.msPerPx;
  const visible = useMemo(() => {
    const from = lowerBound(timed, tA);
    const out: { item: TimedItem; lane: number }[] = [];
    const crossA = crossScroll - OVERSCAN_PX;
    const crossB = crossScroll + viewSize.cross + OVERSCAN_PX;
    for (let i = from; i < timed.length; i += 1) {
      const item = timed[i];
      if (!item || item.t > tB) break;
      const itemLane = packed.lanes[i] ?? 0;
      const crossPos = GUTTER + itemLane * lane;
      if (crossPos + thumb >= crossA && crossPos <= crossB) out.push({ item, lane: itemLane });
    }
    return out;
  }, [timed, packed, tA, tB, crossScroll, viewSize.cross, lane, thumb]);

  // Ask Rust for thumbnails of what's on screen (debounced while panning).
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs, thumbErrors } = useAppStore.getState();
      const wanted = visible
        .map(({ item }) => item.entry.path)
        .filter((path) => !(path in thumbs) && !(path in thumbErrors));
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [visible, epoch]);

  if (entries.length === 0) {
    return <p className="hint">Nothing on the timeline.</p>;
  }

  const ticks = timeTicks(tA, tB, view.msPerPx);
  const crossContent = GUTTER + packed.laneCount * lane + LANE_GAP;


  return (
    <div className={`timeline-gallery ${vertical ? "vertical" : "horizontal"}`}>
      {win !== null && (
        <button
          className="tl-fit"
          title="zoom out to the whole time range — ⌘ scroll zooms, drag pans"
          onClick={() => setWin(null)}
        >
          show all
        </button>
      )}
      <div
        ref={scrollRef}
        className="tl-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          setCrossScroll(vertical ? el.scrollLeft : el.scrollTop);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="tl-canvas"
          style={vertical ? { width: crossContent, height: "100%" } : { height: crossContent, width: "100%" }}
        >
          {ticks.map(({ t, label }) => {
            const pos = mainPx(t);
            return (
              <div
                key={t}
                className="tl-tick"
                style={vertical ? { top: pos, width: crossContent } : { left: pos, height: crossContent }}
              >
                <span className="tl-tick-label">{label}</span>
              </div>
            );
          })}
          <div className="tl-axis" style={vertical ? { left: GUTTER - 6 } : { top: GUTTER - 6 }} />
          {visible.map(({ item, lane: itemLane }) => (
            <TimelineThumb
              key={item.entry.path}
              item={item}
              main={mainPx(item.t)}
              cross={GUTTER + itemLane * lane}
              size={thumb}
              vertical={vertical}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineThumb({
  item,
  main,
  cross,
  size,
  vertical,
}: {
  item: TimedItem;
  main: number;
  cross: number;
  size: number;
  vertical: boolean;
}) {
  const cacheFile = useAppStore((s) => s.thumbs[item.entry.path]);
  const error = useAppStore((s) => s.thumbErrors[item.entry.path]);
  const selected = useAppStore((s) => s.selection.includes(item.entry.path));
  const lead = useAppStore((s) => s.selectedIndex === item.index);
  const openViewer = useAppStore((s) => s.openViewer);
  const pos = vertical ? { top: main, left: cross } : { left: main, top: cross };
  const when = new Date(item.t).toLocaleString();
  // Beyond what the 256px cached thumb can fill (device pixels), the items
  // on view lazily load the original on top of the thumb — the photo
  // upgrades from soft to sharp in place, never to a blank.
  const wantsFull = size * window.devicePixelRatio > THUMB_SOURCE_EDGE;
  return (
    <figure
      className={`tl-item${selected ? " selected" : ""}${lead ? " lead" : ""}`}
      style={{ ...pos, width: size, height: size }}
      title={`${item.entry.name} · ${when}${item.taken ? "" : " (modified)"}`}
      onClick={(e) => useAppStore.getState().selectAt(item.index, selectMode(e))}
      onDoubleClick={() => openViewer(item.index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.getState().selectForMenu(item.index);
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {cacheFile !== undefined ? (
        <>
          <img src={fileUrl(cacheFile)} alt={item.entry.name} loading="lazy" draggable={false} />
          {wantsFull && (
            <img
              className="tl-full"
              src={fileUrl(item.entry.path)}
              alt=""
              loading="lazy"
              draggable={false}
            />
          )}
        </>
      ) : error !== undefined ? (
        <span className="thumb-error" title={error}>
          ⚠
        </span>
      ) : (
        <span className="thumb-pending" />
      )}
    </figure>
  );
}

/** The previous window when nothing moved (a clamped edge), else the next —
 * so holding a pinch against a bound doesn't re-render per event. */
function replaceWin(prev: TimeWindow | null, next: TimeWindow): TimeWindow | null {
  return prev !== null && prev.t0 === next.t0 && prev.msPerPx === next.msPerPx ? prev : next;
}

/** First index in time-sorted `items` with t >= target. */
function lowerBound(items: TimedItem[], target: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid]?.t ?? Infinity) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
