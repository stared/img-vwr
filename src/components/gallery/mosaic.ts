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

/* ---- Bands: the true one-scale packing ---- */

/**
 * One placed photograph: where it sits within its band, which entry it is.
 * `index` is the index into the visible list — packing moves pixels, never
 * the selection's coordinates.
 */
export interface BandCell {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One horizontal band of the mosaic, fully tiled by its cells. */
export interface MosaicBand {
  height: number;
  cells: BandCell[];
}

/** Justified rows re-expressed as bands, so one renderer draws both modes. */
export function rowsToBands(rows: readonly MosaicRow[]): MosaicBand[] {
  return rows.map((row) => {
    let x = 0;
    const cells = row.widths.map((width, i) => {
      const cell = { index: row.firstIndex + i, x, y: 0, width, height: row.height };
      x += width;
      return cell;
    });
    return { height: row.height, cells };
  });
}

/**
 * The one-scale packing: bands three landscape-rows tall, tiled by vertical
 * stacks.
 *
 * A row of one height cannot show a rotated sensor honestly: the portrait
 * next to a landscape comes out at two thirds the scale. Equal scale means
 * the portrait stands taller — so the layout goes two-dimensional. Each
 * band is `3 × rowHeight` tall and fills with columns; a column is a stack
 * of same-orientation photographs whose heights must sum to the band's
 * exactly, which pins its width at `band / Σ(1/aspect)` — no holes, by
 * construction. Three landscapes stack to a column of the familiar row
 * height; two portraits stack half again as tall and narrower — and those
 * two cells have the same diagonal, which for a rotated sensor is the same
 * scale. Odd shapes (crops, squares, panoramas) pick their own stack count,
 * whichever brings their diagonal closest to nominal: squares pair up
 * exactly, a tall crop stands alone, panoramas stack three.
 *
 * Chronology anchors it: every column starts with the oldest photograph
 * still waiting and fills from a small look-ahead window, so order bends
 * only locally. A band that overshoots the width is justified by one small
 * uniform scale — the whole wall still reads at one size.
 */
export function bandedMosaic(
  aspects: readonly number[],
  width: number,
  rowHeight: number,
  window = 16,
): MosaicBand[] {
  const bands: MosaicBand[] = [];
  if (width <= 0 || rowHeight <= 0 || aspects.length === 0) return bands;

  const aspectOf = (i: number) => Math.max(0.1, Math.min(10, aspects[i] ?? DEFAULT_ASPECT));
  const B = 3 * rowHeight;
  // The nominal cell diagonal: a 3:2 landscape at the familiar row height.
  const diagonal = Math.hypot(1.5, 1) * rowHeight;
  // Past this a cell reads as zoomed — bigger than the wall's scale, and
  // bigger than its thumbnail has pixels for.
  const ZOOM_CAP = 1.2;
  const pool = aspects.map((_, i) => i);

  while (pool.length > 0) {
    // Columns laid at nominal scale; justified to the width afterwards.
    const columns: { width: number; picks: number[] }[] = [];
    let x = 0;
    while (pool.length > 0 && x < width) {
      // Stack size: whichever count lands its worst cell's diagonal nearest
      // the nominal one. The column must fill the band top to bottom, so
      // its width is a consequence of what it holds, never a free choice —
      // and a cell blown past nominal is a photograph zoomed beyond its
      // thumbnail, which is the one thing this layout must never do.
      const evaluate = (cands: number[]) => {
        let take = 1;
        let bestErr = Infinity;
        let zoom = Infinity;
        let inv = 0;
        for (let k = 1; k <= cands.length; k += 1) {
          inv += 1 / aspectOf(pool[cands[k - 1] ?? 0] ?? 0);
          const w = B / inv;
          let err = 0;
          let widest = 0;
          for (let i = 0; i < k; i += 1) {
            const d = w * Math.hypot(1, 1 / aspectOf(pool[cands[i] ?? 0] ?? 0));
            err = Math.max(err, Math.abs(d - diagonal));
            widest = Math.max(widest, d);
          }
          if (err < bestErr) {
            bestErr = err;
            take = k;
            zoom = widest;
          }
        }
        return { take, err: bestErr, zoom };
      };
      const sameClass = (limit: number): number[] => {
        const landscape = aspectOf(pool[0] ?? 0) >= 1;
        const out: number[] = [];
        for (let j = 0; j < limit && out.length < 4; j += 1) {
          if (aspectOf(pool[j] ?? 0) >= 1 === landscape) out.push(j);
        }
        return out;
      };

      // The anchor's orientation, from the look-ahead window first. An
      // orphan — no partner in the window — would zoom; before letting it,
      // look for partners anywhere later, and failing that share a mixed
      // column with whatever comes next: an orientation shown a little
      // small beats one blown up soft.
      let candidates = sameClass(Math.min(window, pool.length));
      let pick = evaluate(candidates);
      if (pick.zoom > diagonal * ZOOM_CAP) {
        const extended = sameClass(pool.length);
        const far = evaluate(extended);
        if (far.err < pick.err) {
          candidates = extended;
          pick = far;
        }
      }
      if (pick.zoom > diagonal * ZOOM_CAP) {
        const mixed = Array.from({ length: Math.min(4, pool.length) }, (_, j) => j);
        const near = evaluate(mixed);
        if (near.err < pick.err) {
          candidates = mixed;
          pick = near;
        }
      }
      const picks = candidates
        .slice(0, pick.take)
        // Splice from the back so earlier positions stay valid.
        .reverse()
        .map((j) => pool.splice(j, 1)[0] ?? 0)
        .reverse();
      const colInv = picks.reduce((sum, i) => sum + 1 / aspectOf(i), 0);
      const colWidth = B / colInv;
      columns.push({ width: colWidth, picks });
      x += colWidth;
    }

    // Close the band on whichever reads truer: squeezing the overshooting
    // column in, or handing it back and stretching without it. Either way
    // the correction stays well under half a column, so band-to-band scale
    // barely moves.
    const last = columns[columns.length - 1];
    if (columns.length > 1 && last !== undefined && x > width) {
      const withoutX = x - last.width;
      if (x - width > width - withoutX) {
        pool.unshift(...last.picks);
        columns.pop();
        x = withoutX;
      }
    }
    const scale = pool.length === 0 && x < width ? 1 : width / x;
    const cells: BandCell[] = [];
    let atX = 0;
    for (const [c, column] of columns.entries()) {
      const left = Math.round(atX * scale);
      const right =
        c === columns.length - 1 && scale !== 1
          ? width
          : Math.round((atX + column.width) * scale);
      let atY = 0;
      for (const [r, index] of column.picks.entries()) {
        const top = Math.round(atY * scale);
        atY += column.width / aspectOf(index);
        const bottom = r === column.picks.length - 1 ? Math.round(B * scale) : Math.round(atY * scale);
        cells.push({ index, x: left, y: top, width: right - left, height: bottom - top });
      }
      atX += column.width;
    }
    bands.push({ height: Math.round(B * scale), cells });
  }
  return bands;
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
