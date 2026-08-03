import { useEffect, useRef } from "react";

import { fileUrl, requestThumbnails } from "../../ipc";
import { useAppStore, useVisibleEntries } from "../../state/store";

/**
 * The darkroom's strip of the whole collection, running under the main image.
 *
 * Not virtualized: a filmstrip's job is to let you see where you are in a
 * sequence, and its cells are small enough that even a few thousand cost
 * little. Thumbnails are still requested lazily, for the part on screen.
 */

const REQUEST_DEBOUNCE_MS = 50;

export function Filmstrip({ height }: { height: number }) {
  const entries = useVisibleEntries();
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const select = useAppStore((s) => s.select);
  const epoch = useAppStore((s) => s.epoch);
  const thumbs = useAppStore((s) => s.thumbs);
  const labels = useAppStore((s) => s.labels);
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
      const { scrollLeft, clientWidth } = strip;
      const cellWidth = height + 6;
      const first = Math.max(0, Math.floor(scrollLeft / cellWidth) - 4);
      const last = Math.min(entries.length, Math.ceil((scrollLeft + clientWidth) / cellWidth) + 4);
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
            className={index === selectedIndex ? "filmstrip-cell selected" : "filmstrip-cell"}
            style={{ width: height - 12, height: height - 12 }}
            title={entry.name}
            onClick={() => select(index)}
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
