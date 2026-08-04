import { useEffect, useRef } from "react";

import { fileUrl, requestThumbnails } from "../../ipc";
import { siblingsOf, stackCaption } from "../../state/stacks";
import { selectMode, useAppStore, useVisibleEntries } from "../../state/store";

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

export function Filmstrip({ height }: { height: number }) {
  const entries = useVisibleEntries();
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const selection = useAppStore((s) => s.selection);
  const select = useAppStore((s) => s.select);
  const epoch = useAppStore((s) => s.epoch);
  const thumbs = useAppStore((s) => s.thumbs);
  const labels = useAppStore((s) => s.labels);
  // Every file in the collection, so a collapsed cell can say what else is
  // in its stack — the strip itself is showing one member of each.
  const allEntries = useAppStore((s) => s.entries);
  const stacking = useAppStore((s) => s.stacking);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the current frame in view as the selection moves by keyboard.
  useEffect(() => {
    if (selectedIndex === null) return;
    const strip = stripRef.current;
    const cell = strip?.children[selectedIndex];
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
        entries.length,
      );
      const wanted = entries
        .slice(first, last)
        .map((e) => e.path)
        .filter((path) => !(path in have) && !(path in thumbErrors));
      if (wanted.length > 0) void requestThumbnails(wanted, epoch);
    };
    const timer = setTimeout(request, REQUEST_DEBOUNCE_MS);
    strip.addEventListener("scroll", request, { passive: true });
    return () => {
      clearTimeout(timer);
      strip.removeEventListener("scroll", request);
    };
  }, [entries, epoch, height]);

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
      {entries.map((entry, index) => {
        const thumb = thumbs[entry.path];
        const stars = labels[entry.path]?.stars ?? null;
        return (
          <button
            key={entry.path}
            className={[
              "filmstrip-cell",
              selection.includes(entry.path) ? "selected" : "",
              index === selectedIndex ? "lead" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: height - 12, height: height - 12 }}
            title={stacking ? stackCaption(entry, siblingsOf(allEntries, entry)) : entry.name}
            onClick={(e) => useAppStore.getState().selectAt(index, selectMode(e))}
            // The same menu the grid has: culling happens here too, and the
            // strip is the only list the darkroom shows.
            onContextMenu={(e) => {
              e.preventDefault();
              useAppStore.getState().selectForMenu(index);
              useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {/* The same mark the grid puts on a thumbnail. Culling happens
                here as much as there, and a rating you cannot see while
                working through a sequence may as well not exist. */}
            {stars !== null && <span className="thumb-stars">{"★".repeat(stars)}</span>}
            {thumb === undefined ? (
              <span className="filmstrip-placeholder" />
            ) : (
              <img src={fileUrl(thumb)} alt={entry.name} draggable={false} />
            )}
          </button>
        );
      })}
    </div>
  );
}
