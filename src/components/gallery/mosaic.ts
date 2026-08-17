import type { Crop, FileEntry, ImageMeta } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { croppedBoxRatio } from "./CroppedThumb";

/**
 * The mosaic's geometry: justified rows, like a page of contact prints cut
 * to fit. Every photograph keeps its own shape — a cropped one the crop's —
 * and each row is scaled so its pictures fill the width edge to edge, so
 * the layout has no letterboxing and no dead cell space anywhere.
 *
 * Pure: aspects in, row descriptors out. The component slices entries at
 * render, the same bargain the grid's rows strike.
 */

/** What a photograph looks like before its metadata has arrived. */
const DEFAULT_ASPECT = 3 / 2;

/** One justified row: a run of entries, its height, and each cell's width. */
export interface MosaicRow {
  firstIndex: number;
  count: number;
  height: number;
  widths: number[];
}

/** Each entry's display aspect (width over height): the crop's shape where
 * one is stored — the miniature is the crop — else the frame's own. */
export function mosaicAspects(
  entries: readonly FileEntry[],
  meta: Record<string, ImageMeta>,
  crops: Record<string, Crop>,
): number[] {
  return entries.map((entry) => {
    const m = meta[entry.path];
    const dims = m === undefined ? null : effectiveDims(m);
    const frame = dims === null ? DEFAULT_ASPECT : dims.width / dims.height;
    const crop = crops[entry.path];
    return crop === undefined ? frame : croppedBoxRatio(crop, frame);
  });
}

/**
 * Pack aspects into justified rows.
 *
 * Greedy: a row takes photographs until they would have to shrink below the
 * target height to fit, then is scaled to fill the width exactly — so rows
 * come out at or a little under `targetHeight`, never above it except for
 * the last row, which keeps the target height rather than stretching its
 * few photographs into billboards.
 */
export function mosaicRows(
  aspects: readonly number[],
  width: number,
  targetHeight: number,
  gap: number,
): MosaicRow[] {
  const rows: MosaicRow[] = [];
  if (width <= 0 || aspects.length === 0) return rows;

  let first = 0;
  while (first < aspects.length) {
    let sum = 0;
    let count = 0;
    while (first + count < aspects.length) {
      const aspect = Math.max(0.1, aspects[first + count] ?? DEFAULT_ASPECT);
      sum += aspect;
      count += 1;
      const usable = width - gap * (count - 1);
      if (usable / sum <= targetHeight) break;
    }
    const usable = width - gap * (count - 1);
    const filled = usable / sum;
    // The last row justifies only if it already fills; otherwise its
    // photographs keep the target height and the row ends where they do.
    const last = first + count >= aspects.length;
    const height = Math.round(last && filled > targetHeight ? targetHeight : filled);

    const widths: number[] = [];
    let used = 0;
    for (let i = 0; i < count; i += 1) {
      const aspect = Math.max(0.1, aspects[first + i] ?? DEFAULT_ASPECT);
      // The final cell of a justified row absorbs the rounding, so the row
      // meets the right edge to the pixel.
      const exact =
        i === count - 1 && (!last || filled <= targetHeight)
          ? usable - used
          : Math.round(aspect * height);
      widths.push(exact);
      used += exact;
    }
    rows.push({ firstIndex: first, count, height, widths });
    first += count;
  }
  return rows;
}
