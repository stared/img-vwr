import { useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "../../ipc";
import { fileUrl, requestThumbnails } from "../../ipc";
import { takenMs } from "../../state/derived";
import { useAppStore, useVisibleEntries } from "../../state/store";
import type { TimeWindow } from "./timeline";
import { fitWindow, packLanes, pannedWindow, timeTicks, zoomedWindow } from "./timeline";

/**
 * The gallery as a timeline: every visible entry sits on a time axis at its
 * date taken (EXIF; falls back to modified). Photos never overlap — one
 * landing on an occupied stretch shifts a lane further from the axis. The
 * axis runs vertically or horizontally; wheel (or drag) pans along time,
 * ⌘/ctrl+wheel and the ± buttons zoom around the cursor. Time is a
 * pan/zoom window, not a scrollable canvas — a deeply zoomed year is more
 * pixels than an element can be.
 */

const THUMB = 64;
const LANE_GAP = 6;
const LANE = THUMB + LANE_GAP;
/** Room for the axis line and its date labels. */
const GUTTER = 76;
const OVERSCAN_PX = 200;
const REQUEST_DEBOUNCE_MS = 50;
const ZOOM_STEP = 1.5;

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
  const setTimelineOrientation = useAppStore((s) => s.setTimelineOrientation);

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

  // A new scope starts back at the full range.
  useEffect(() => setWin(null), [epoch]);

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

  // Lane packing spans the whole collection at the current zoom, so lanes
  // are stable while panning; only the assignment depends on msPerPx.
  const packed = useMemo(
    () => packLanes(timed.map((i) => i.t), LANE * view.msPerPx),
    [timed, view.msPerPx],
  );

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
        const factor = Math.exp(e.deltaY * 0.01);
        setWin((w) =>
          zoomedWindow(w ?? fitWindow(tMin, tMax, viewPx), factor, alongMain, tMin, tMax, viewPx),
        );
      } else {
        const mainDelta = vertical ? e.deltaY : e.deltaX || e.deltaY;
        const crossDelta = vertical ? e.deltaX : e.deltaX ? e.deltaY : 0;
        setWin((w) => pannedWindow(w ?? fitWindow(tMin, tMax, viewPx), mainDelta, tMin, tMax, viewPx));
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
    setWin((w) => pannedWindow(w ?? fit, start.main - main, tMin, tMax, viewSize.main));
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
  const tA = view.t0 - (OVERSCAN_PX + LANE) * view.msPerPx;
  const tB = view.t0 + (viewSize.main + OVERSCAN_PX) * view.msPerPx;
  const visible = useMemo(() => {
    const from = lowerBound(timed, tA);
    const out: { item: TimedItem; lane: number }[] = [];
    const crossA = crossScroll - OVERSCAN_PX;
    const crossB = crossScroll + viewSize.cross + OVERSCAN_PX;
    for (let i = from; i < timed.length; i += 1) {
      const item = timed[i];
      if (!item || item.t > tB) break;
      const lane = packed.lanes[i] ?? 0;
      const crossPos = GUTTER + lane * LANE;
      if (crossPos + THUMB >= crossA && crossPos <= crossB) out.push({ item, lane });
    }
    return out;
  }, [timed, packed, tA, tB, crossScroll, viewSize.cross]);

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
  const crossContent = GUTTER + packed.laneCount * LANE + LANE_GAP;
  const takenCount = timed.reduce((n, i) => n + (i.taken ? 1 : 0), 0);
  const zoomAtCenter = (factor: number) =>
    setWin((w) => zoomedWindow(w ?? fit, factor, viewSize.main / 2, tMin, tMax, viewSize.main));

  return (
    <div className={`timeline-gallery ${vertical ? "vertical" : "horizontal"}`}>
      <div className="tl-toolbar">
        <button
          title={vertical ? "horizontal timeline" : "vertical timeline"}
          onClick={() => {
            setTimelineOrientation(vertical ? "horizontal" : "vertical");
            setWin(null);
          }}
        >
          {vertical ? "⇅" : "⇆"}
        </button>
        <button title="zoom out (⌘+wheel)" onClick={() => zoomAtCenter(ZOOM_STEP)}>
          −
        </button>
        <button title="zoom in (⌘+wheel)" onClick={() => zoomAtCenter(1 / ZOOM_STEP)}>
          +
        </button>
        <button title="fit the whole range" onClick={() => setWin(null)}>
          fit
        </button>
        <span className="tl-note">
          {timed.length} on the timeline
          {takenCount < timed.length && ` · ${timed.length - takenCount} by modified date`}
        </span>
      </div>
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
          {visible.map(({ item, lane }) => (
            <TimelineThumb
              key={item.entry.path}
              item={item}
              main={mainPx(item.t)}
              cross={GUTTER + lane * LANE}
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
  vertical,
}: {
  item: TimedItem;
  main: number;
  cross: number;
  vertical: boolean;
}) {
  const cacheFile = useAppStore((s) => s.thumbs[item.entry.path]);
  const error = useAppStore((s) => s.thumbErrors[item.entry.path]);
  const selected = useAppStore((s) => s.selectedIndex === item.index);
  const openViewer = useAppStore((s) => s.openViewer);
  const pos = vertical ? { top: main, left: cross } : { left: main, top: cross };
  const when = new Date(item.t).toLocaleString();
  return (
    <figure
      className={`tl-item${selected ? " selected" : ""}`}
      style={{ ...pos, width: THUMB, height: THUMB }}
      title={`${item.entry.name} · ${when}${item.taken ? "" : " (modified)"}`}
      onClick={() => useAppStore.setState({ selectedIndex: item.index })}
      onDoubleClick={() => openViewer(item.index)}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.setState({ selectedIndex: item.index });
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {cacheFile !== undefined ? (
        <img src={fileUrl(cacheFile)} alt={item.entry.name} loading="lazy" draggable={false} />
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
