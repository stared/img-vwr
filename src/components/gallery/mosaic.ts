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
 * A display order that keeps every photograph at (nearly) one scale.
 *
 * In-order rows must stretch or shrink to meet the right edge, so their
 * scales drift with whatever run of shapes the sort dealt them. Reordering
 * fixes that: each row starts with the oldest photograph still waiting —
 * chronology stays the anchor — and then fills from a small look-ahead
 * window, always taking the widest photograph that still fits. Rows come
 * out almost exactly full, so the justify step barely scales anything and
 * the whole mosaic reads at one size.
 *
 * `rowAspect` is the row's capacity in aspect units (width over target
 * height); `gapAspect` is what each additional photograph's gap costs in
 * the same units. Returns a permutation of indices.
 */
export function packedOrder(
  aspects: readonly number[],
  rowAspect: number,
  gapAspect: number,
  window = 16,
): number[] {
  const pool = aspects.map((_, i) => i);
  const order: number[] = [];
  const aspectOf = (i: number) => Math.max(0.1, aspects[i] ?? DEFAULT_ASPECT);
  while (pool.length > 0) {
    let cap = rowAspect - aspectOf(pool[0] ?? 0);
    order.push(pool.shift() ?? 0);
    for (;;) {
      let best = -1;
      let bestCost = -Infinity;
      const lookahead = Math.min(window, pool.length);
      for (let j = 0; j < lookahead; j += 1) {
        const cost = aspectOf(pool[j] ?? 0) + gapAspect;
        // A hair of tolerance, so a row can end a whisker over-full and be
        // scaled down a touch rather than leaving a portrait-wide hole.
        if (cost <= cap + 0.05 && cost > bestCost) {
          bestCost = cost;
          best = j;
        }
      }
      if (best === -1) {
        // Nothing fits whole. Close the row on whichever reads truer: the
        // hole it would leave, or the squeeze of the narrowest photograph
        // still waiting. A row always slightly over-full justifies with a
        // small scale-down — and it keeps the row boundaries here agreeing
        // with the ones `mosaicRows` finds again on the reordered list.
        let narrow = -1;
        let narrowCost = Infinity;
        for (let j = 0; j < lookahead; j += 1) {
          const cost = aspectOf(pool[j] ?? 0) + gapAspect;
          if (cost < narrowCost) {
            narrowCost = cost;
            narrow = j;
          }
        }
        if (narrow !== -1 && narrowCost - cap < cap) {
          order.push(pool.splice(narrow, 1)[0] ?? 0);
        }
        break;
      }
      cap -= bestCost;
      order.push(pool.splice(best, 1)[0] ?? 0);
    }
  }
  return order;
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
