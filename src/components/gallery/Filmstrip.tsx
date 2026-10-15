import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { fileUrl, requestThumbnails, type FileEntry } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { groupStacks, pairedName, stackCaption, stackKeyOf } from "../../state/stacks";
import { selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import { ThumbLabels } from "../../labels/TagDot";
import { CropBadge, CroppedThumb } from "./CroppedThumb";

const REQUEST_DEBOUNCE_MS = 50;

const OVERSCAN = 6;

const GAP = 6;
/** Matches `.filmstrip-cell.stacked`'s margin: the deck's prints need the room. */
const STACK_MARGIN = 6;

/** Left edge of every cell, plus the strip's full width; stacked cells carry extra margin, so the pitch is not uniform. */
export function stripLayout(stacked: boolean[], cellWidth: number): { lefts: number[]; total: number } {
  const lefts: number[] = [];
  let x = 0;
  for (const s of stacked) {
    if (s) x += STACK_MARGIN;
    lefts.push(x);
    x += cellWidth + GAP;
  }
  return { lefts, total: Math.max(0, x - GAP) };
}

/** Cells overlapping the viewport, widened by `overscan` on each side. */
export function stripRange(
  lefts: number[],
  cellWidth: number,
  view: { scrollLeft: number; clientWidth: number },
  overscan = OVERSCAN,
): { first: number; last: number } {
  // First cell whose right edge is past `x`.
  const firstPast = (x: number) => {
    let lo = 0;
    let hi = lefts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((lefts[mid] ?? 0) + cellWidth <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    first: Math.max(0, firstPast(view.scrollLeft) - overscan),
    last: Math.min(lefts.length, firstPast(view.scrollLeft + view.clientWidth) + 1 + overscan),
  };
}

interface StripCell {
  entry: FileEntry;
  /** Index into the visible list; null for a member shown only because its stack is spread. */
  index: number | null;
  key: string;
}

/** The visible list stays collapsed (selection indexes into it); spread-stack members are extras only the strip knows. */
export function stripCells(
  visible: FileEntry[],
  all: FileEntry[],
  expanded: Record<string, true>,
  stacking: boolean,
): StripCell[] {
  const cells: StripCell[] = [];
  visible.forEach((entry, index) => {
    const key = stackKeyOf(entry);
    // `all` is in disk-scan order, so members need the explicit sort to read as the shot sequence.
    const members =
      stacking && expanded[key] !== undefined
        ? all
            .filter((e) => stackKeyOf(e) === key)
            .sort((a, b) => (a.path < b.path ? -1 : 1))
        : [];
    if (members.length < 2) {
      cells.push({ entry, index, key });
      return;
    }
    for (const member of members) {
      cells.push({ entry: member, index: member.path === entry.path ? index : null, key });
    }
  });
  return cells;
}

export function Filmstrip({ height }: { height: number }) {
  const entries = useVisibleEntries();
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const selection = useAppStore((s) => s.selection);
  const select = useAppStore((s) => s.select);
  const epoch = useAppStore((s) => s.epoch);
  const thumbs = useAppStore((s) => s.thumbs);
  const crops = useAppStore((s) => s.crops);
  const meta = useAppStore((s) => s.meta);
  const allEntries = useAppStore((s) => s.entries);
  const stacking = useAppStore((s) => s.stacking);
  const expandedStacks = useAppStore((s) => s.expandedStacks);
  const stripRef = useRef<HTMLDivElement>(null);

  const cells = useMemo(
    () => stripCells(entries, allEntries, expandedStacks, stacking),
    [entries, allEntries, expandedStacks, stacking],
  );
  // One pass over the folder; a per-cell scan made a render quadratic.
  const stacks = useMemo(
    () => (stacking ? groupStacks(allEntries) : null),
    [allEntries, stacking],
  );
  const placed = useMemo(
    () =>
      cells.map((cell) => {
        const spread = stacking && expandedStacks[cell.key] !== undefined;
        const siblings =
          stacks && cell.index !== null
            ? (stacks.get(cell.key) ?? []).filter((e) => e.path !== cell.entry.path)
            : [];
        return { ...cell, spread, siblings, stacked: siblings.length > 0 && !spread };
      }),
    [cells, stacks, stacking, expandedStacks],
  );
  const cellWidth = height - 12;
  const { lefts, total } = useMemo(
    () => stripLayout(placed.map((c) => c.stacked), cellWidth),
    [placed, cellWidth],
  );

  const [view, setView] = useState({ scrollLeft: 0, clientWidth: 0 });
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setView({ scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, []);
  const { first, last } = stripRange(lefts, cellWidth, view);

  // By position, not the DOM: the lead may not be mounted yet.
  useEffect(() => {
    const strip = stripRef.current;
    const at = placed.findIndex((c) => c.index !== null && c.index === selectedIndex);
    if (!strip || at < 0) return;
    const left = lefts[at] ?? 0;
    if (left < strip.scrollLeft || left + cellWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: left - (strip.clientWidth - cellWidth) / 2, behavior: "smooth" });
    }
  }, [selectedIndex]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const { thumbs: have, thumbErrors } = useAppStore.getState();
      const wanted = placed
        .slice(first, last)
        .map((c) => c.entry.path)
        .filter((path) => !(path in have) && !(path in thumbErrors));
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [placed, first, last, epoch]);

  return (
    <div
      className="filmstrip"
      ref={stripRef}
      style={{ height }}
      onClick={(e) => {
        if (e.target === e.currentTarget || e.target === e.currentTarget.firstChild) select(null);
      }}
    >
      <div className="filmstrip-track" style={{ width: total }}>
      {placed.slice(first, last).map(({ entry, index, key, spread, siblings }, i) => {
        const thumb = thumbs[entry.path];
        const member = index === null;
        // A collapsed pair is one photograph: a crop stored on either file crops the cell.
        const crop =
          crops[entry.path] ??
          (siblings.length > 0 && !spread
            ? siblings.map((s) => crops[s.path]).find((c) => c !== undefined)
            : undefined);
        const cellMeta = meta[entry.path];
        const dims = cellMeta === undefined ? null : effectiveDims(cellMeta);
        const cropped =
          crop !== undefined && dims !== null
            ? { crop, frame: dims.width / dims.height }
            : null;
        return (
          <button
            key={entry.path}
            className={[
              "filmstrip-cell",
              selection.includes(entry.path) ? "selected" : "",
              index !== null && index === selectedIndex ? "lead" : "",
              siblings.length > 0 && !spread ? "stacked" : "",
              spread ? "unstacked" : "",
              member ? "member" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ left: lefts[first + i], width: cellWidth, height: cellWidth }}
            title={
              member
                ? `${entry.name} — in this stack; click to show it in front`
                : spread
                  ? `${entry.name} — the one in front; double-click to restack`
                  : siblings.length > 0
                    ? `${stackCaption(entry, siblings)} — double-click to spread the stack`
                    : stacking
                      ? stackCaption(entry, siblings)
                      : entry.name
            }
            onClick={(e) => {
              if (index === null) {
                useAppStore.getState().preferMember(entry.path);
                return;
              }
              useAppStore.getState().selectAt(index, selectMode(e));
            }}
            onDoubleClick={() => {
              if (index === null || (siblings.length === 0 && !spread)) return;
              useAppStore.getState().toggleStackExpanded(key);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (index === null) return;
              useAppStore.getState().selectForMenu(index);
              useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <ThumbLabels path={entry.path} />
            <span className="filmstrip-photo">
              {cropped !== null && <CropBadge />}
              {thumb !== undefined && siblings.length > 0 && !spread && (
                <>
                  {siblings.length >= 2 &&
                    (cropped !== null ? (
                      <CroppedThumb className="filmstrip-card deep" src={fileUrl(thumb)} alt="" crop={cropped.crop} frame={cropped.frame} />
                    ) : (
                      <img className="filmstrip-card deep" src={fileUrl(thumb)} alt="" draggable={false} />
                    ))}
                  {cropped !== null ? (
                    <CroppedThumb className="filmstrip-card" src={fileUrl(thumb)} alt="" crop={cropped.crop} frame={cropped.frame} />
                  ) : (
                    <img className="filmstrip-card" src={fileUrl(thumb)} alt="" draggable={false} />
                  )}
                </>
              )}
              {thumb === undefined ? (
                <span className="filmstrip-placeholder" />
              ) : cropped !== null ? (
                <CroppedThumb src={fileUrl(thumb)} alt={entry.name} crop={cropped.crop} frame={cropped.frame} />
              ) : (
                <img src={fileUrl(thumb)} alt={entry.name} draggable={false} />
              )}
            </span>
            <span className="filmstrip-name">
              {siblings.length > 0 && !spread ? pairedName(entry, siblings) : entry.name}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
