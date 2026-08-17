import { useEffect, useMemo, useRef } from "react";

import { fileUrl, requestThumbnails, type FileEntry } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { hdrLabel } from "../../state/hdr";
import { pairedName, photographKeyOf, siblingsOf, stackCaption } from "../../state/stacks";
import { hdrOf, selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import { CropBadge, CroppedThumb } from "./CroppedThumb";

/**
 * The darkroom's strip of the whole collection, running under the main image.
 *
 * Not virtualized: a filmstrip's job is to let you see where you are in a
 * sequence, and its cells are small enough that even a few thousand cost
 * little. Thumbnails are still requested lazily, for the part on screen.
 */

const REQUEST_DEBOUNCE_MS = 50;

/** Cells fetched beyond each edge, so a flick of the strip is already filled. */
const OVERSCAN = 6;

/**
 * Which cells are on screen, given where the strip is scrolled to.
 *
 * `pitch` and `origin` are measured off the laid-out cells rather than
 * recomputed from the height. They used to be recomputed, wrongly — the
 * assumed pitch was 12 px larger than the CSS produces, which by frame 100
 * pointed nine cells away from what was on screen. The strip you had just
 * scrolled to stayed blank while thumbnails were fetched for images nobody
 * could see, and the further in you were the worse it got.
 */
export function stripRange(
  view: { scrollLeft: number; clientWidth: number },
  layout: { origin: number; pitch: number },
  count: number,
  overscan = OVERSCAN,
): { first: number; last: number } {
  if (layout.pitch <= 0 || count === 0) return { first: 0, last: 0 };
  const at = (x: number) => (x - layout.origin) / layout.pitch;
  return {
    first: Math.max(0, Math.floor(at(view.scrollLeft)) - overscan),
    last: Math.min(count, Math.ceil(at(view.scrollLeft + view.clientWidth)) + overscan),
  };
}

/** One cell of the strip: a visible photograph, or — when its stack is
 * spread open — one member of it. */
export interface StripCell {
  entry: FileEntry;
  /** Index into the visible list, or null for a member that is on screen
   * only because its stack is spread. */
  index: number | null;
  /** The photograph the cell belongs to. */
  key: string;
}

/**
 * The strip's cells: the visible list, with each spread stack replaced by
 * all of its members in file order.
 *
 * The visible list itself stays collapsed — selection stays an index into
 * it — and the members are extras only the strip knows about. Clicking one
 * routes through `preferMember`, so "show this member" is the same move it
 * is everywhere else in the app.
 */
export function stripCells(
  visible: FileEntry[],
  all: FileEntry[],
  expanded: Record<string, true>,
  hdrKeys: ReadonlyMap<string, string> | null,
  stacking: boolean,
): StripCell[] {
  const cells: StripCell[] = [];
  visible.forEach((entry, index) => {
    const key = photographKeyOf(entry, hdrKeys);
    // By name, not by scan order: `all` is the folder as the disk listed it,
    // and a spread bracket should read as the sequence it was shot in.
    const members =
      stacking && expanded[key] !== undefined
        ? all
            .filter((e) => photographKeyOf(e, hdrKeys) === key)
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
  const labels = useAppStore((s) => s.labels);
  const crops = useAppStore((s) => s.crops);
  const meta = useAppStore((s) => s.meta);
  // Every file in the collection, so a collapsed cell can say what else is
  // in its stack — the strip itself is showing one member of each.
  const allEntries = useAppStore((s) => s.entries);
  const stacking = useAppStore((s) => s.stacking);
  // Which cells front an HDR set, and how the whole photograph groups —
  // a stacked cell should *look* stacked, not merely say so in a tooltip.
  const hdr = useAppStore((s) => hdrOf(s));
  const expandedStacks = useAppStore((s) => s.expandedStacks);
  const stripRef = useRef<HTMLDivElement>(null);

  const cells = useMemo(
    () => stripCells(entries, allEntries, expandedStacks, hdr.keyByStack, stacking),
    [entries, allEntries, expandedStacks, hdr, stacking],
  );

  // Keep the current frame in view as the selection moves by keyboard. Found
  // by its class rather than its position: a spread stack puts extra cells
  // in the strip, so the visible index no longer counts children.
  useEffect(() => {
    if (selectedIndex === null) return;
    const cell = stripRef.current?.querySelector(".lead");
    cell?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedIndex]);

  // Ask for thumbnails of what is actually on screen, as it scrolls past.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const request = () => {
      const { thumbs: have, thumbErrors } = useAppStore.getState();
      // Measured off the laid-out cells; see `stripRange`.
      const [a, b] = [strip.children[0], strip.children[1]] as (HTMLElement | undefined)[];
      const { first, last } = stripRange(
        strip,
        {
          origin: a?.offsetLeft ?? 0,
          pitch: a && b ? b.offsetLeft - a.offsetLeft : (a?.offsetWidth ?? 0),
        },
        cells.length,
      );
      const wanted = cells
        .slice(first, last)
        .map((c) => c.entry.path)
        .filter((path) => !(path in have) && !(path in thumbErrors));
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    };
    const timer = setTimeout(request, REQUEST_DEBOUNCE_MS);
    strip.addEventListener("scroll", request, { passive: true });
    return () => {
      clearTimeout(timer);
      strip.removeEventListener("scroll", request);
    };
  }, [cells, epoch, height]);

  return (
    <div
      className="filmstrip"
      ref={stripRef}
      style={{ height }}
      // Clicking the strip's background clears the selection, like the grid.
      onClick={(e) => {
        if (e.target === e.currentTarget) select(null);
      }}
    >
      {cells.map(({ entry, index, key }) => {
        const thumb = thumbs[entry.path];
        const stars = labels[entry.path]?.stars ?? null;
        const hdrSet = hdr.byFace.get(entry.path) ?? null;
        const spread = stacking && expandedStacks[key] !== undefined;
        const member = index === null;
        const siblings =
          stacking && !member ? siblingsOf(allEntries, entry, hdr.keyByStack) : [];
        // A collapsed pair is one photograph, so a crop stored on either of
        // its files crops the cell; a spread member shows only its own.
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
              // A collapsed stack wears the pile it is: edges of the cards
              // behind it peek out, and an HDR set says what it is. Spread,
              // the pile lies flat: its members run side by side under one
              // thread, and the cards' edges go with it.
              siblings.length > 0 && !spread ? "stacked" : "",
              spread ? "unstacked" : "",
              member ? "member" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: height - 12, height: height - 12 }}
            title={
              member
                ? `${entry.name} — in this stack; click to show it in front`
                : spread
                  ? `${entry.name} — the one in front; click to restack`
                  : hdrSet
                    ? `${entry.name} · ${hdrLabel(hdrSet)} — the fused photograph; click to spread its frames`
                    : siblings.length > 0
                      ? `${stackCaption(entry, siblings)} — click to spread the stack`
                      : stacking
                        ? stackCaption(entry, siblings)
                        : entry.name
            }
            onClick={(e) => {
              const mode = selectMode(e);
              if (index === null) {
                // A spread member: showing it *is* the click's meaning, and
                // preferMember swaps it in front with the selection held.
                useAppStore.getState().preferMember(entry.path);
                return;
              }
              // One plain click does the whole move: the pile you click is
              // the pile you meant to look inside, so it selects and spreads
              // at once — select-then-click-again made every look cost two.
              // On a spread lead the same click folds it back.
              if (mode === "replace" && (siblings.length > 0 || spread)) {
                useAppStore.getState().selectAt(index, mode);
                useAppStore.getState().toggleStackExpanded(key);
                return;
              }
              useAppStore.getState().selectAt(index, mode);
            }}
            // The same menu the grid has: culling happens here too, and the
            // strip is the only list the darkroom shows.
            onContextMenu={(e) => {
              e.preventDefault();
              if (index === null) return;
              useAppStore.getState().selectForMenu(index);
              useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {hdrSet !== null && <span className="thumb-hdr">HDR ×{hdrSet.frames.length}</span>}
            {/* The rating rides on the photograph, at its top — the bottom
                edge belongs to the name. Same mark as the grid's. */}
            {stars !== null && <span className="thumb-stars">{"★".repeat(stars)}</span>}
            <span className="filmstrip-photo">
              {cropped !== null && <CropBadge />}
              {/* The pile is the photograph itself, repeated: one print
                  behind for a pair, two for anything deeper. No painted
                  card — the deck is made of the picture, and its depth is
                  honest. A cropped photograph's pile is cropped prints:
                  the whole deck is the same picture. */}
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
            {/* Which file this is, on its own line under the picture — the
                strip is the darkroom's only list. A collapsed pair is one
                name carrying both formats: "DSC_1234.JPG+NEF". */}
            <span className="filmstrip-name">
              {siblings.length > 0 && !spread ? pairedName(entry, siblings) : entry.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
