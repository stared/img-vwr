import { useEffect, useMemo, useRef } from "react";

import { fileUrl, requestThumbnails, type FileEntry } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { hdrLabel } from "../../state/hdr";
import { pairedName, photographKeyOf, siblingsOf, stackCaption } from "../../state/stacks";
import { hdrOf, selectMode, useAppStore, useVisibleEntries } from "../../state/store";
import { CropBadge, CroppedThumb } from "./CroppedThumb";

const REQUEST_DEBOUNCE_MS = 50;

const OVERSCAN = 6;

/** `pitch` and `origin` must be measured off the laid-out cells; recomputing them from height drifts from the CSS. */
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
  hdrKeys: ReadonlyMap<string, string> | null,
  stacking: boolean,
): StripCell[] {
  const cells: StripCell[] = [];
  visible.forEach((entry, index) => {
    const key = photographKeyOf(entry, hdrKeys);
    // `all` is in disk-scan order, so members need the explicit sort to read as the shot sequence.
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
  const allEntries = useAppStore((s) => s.entries);
  const stacking = useAppStore((s) => s.stacking);
  const hdr = useAppStore((s) => hdrOf(s));
  const expandedStacks = useAppStore((s) => s.expandedStacks);
  const stripRef = useRef<HTMLDivElement>(null);

  const cells = useMemo(
    () => stripCells(entries, allEntries, expandedStacks, hdr.keyByStack, stacking),
    [entries, allEntries, expandedStacks, hdr, stacking],
  );

  // Found by class, not child position: a spread stack adds cells, so the visible index no longer counts children.
  useEffect(() => {
    if (selectedIndex === null) return;
    const cell = stripRef.current?.querySelector(".lead");
    cell?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedIndex]);

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
                useAppStore.getState().preferMember(entry.path);
                return;
              }
              if (mode === "replace" && (siblings.length > 0 || spread)) {
                useAppStore.getState().selectAt(index, mode);
                useAppStore.getState().toggleStackExpanded(key);
                return;
              }
              useAppStore.getState().selectAt(index, mode);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (index === null) return;
              useAppStore.getState().selectForMenu(index);
              useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {hdrSet !== null && <span className="thumb-hdr">HDR ×{hdrSet.frames.length}</span>}
            {stars !== null && <span className="thumb-stars">{"★".repeat(stars)}</span>}
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
  );
}
