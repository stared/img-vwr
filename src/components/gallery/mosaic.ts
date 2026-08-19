import type { Crop, FileEntry, ImageMeta } from "../../ipc";
import { effectiveDims } from "../../state/derived";
import { croppedBoxRatio } from "./CroppedThumb";

const DEFAULT_ASPECT = 3 / 2;

interface MosaicRow {
  firstIndex: number;
  count: number;
  height: number;
  widths: number[];
}

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

interface BandCell {
  /** Index into the visible list; packing never reorders selection coordinates. */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MosaicBand {
  height: number;
  cells: BandCell[];
}

/** Entry visually below (+1) or above (-1) `index`, null at the edge; cells sharing horizontal overlap beat nearer ones aside. */
export function verticalNeighbor(
  bands: readonly MosaicBand[],
  index: number,
  direction: 1 | -1,
): number | null {
  interface Rect {
    index: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  const rects: Rect[] = [];
  let bandTop = 0;
  for (const band of bands) {
    for (const c of band.cells) {
      rects.push({
        index: c.index,
        left: c.x,
        right: c.x + c.width,
        top: bandTop + c.y,
        bottom: bandTop + c.y + c.height,
      });
    }
    bandTop += band.height;
  }
  const from = rects.find((r) => r.index === index);
  if (from === undefined) return null;

  let best: Rect | null = null;
  let bestKey = Infinity;
  for (const r of rects) {
    if (r.index === index) continue;
    // -1 px absorbs rounding at shared edges.
    const beyond = direction > 0 ? r.top - from.bottom : from.top - r.bottom;
    if (beyond < -1) continue;
    const overlap = Math.min(r.right, from.right) - Math.max(r.left, from.left);
    const aside =
      overlap > 0 ? 0 : Math.abs((r.left + r.right) / 2 - (from.left + from.right) / 2);
    const key = Math.max(0, beyond) * 10_000 + aside;
    if (key < bestKey) {
      bestKey = key;
      best = r;
    }
  }
  return best === null ? null : best.index;
}

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

/** Bands 3×rowHeight tall, tiled by stacks; a column's width is band/Σ(1/aspect) so its cells fill the band exactly. */
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
  // Past this a cell is zoomed beyond its thumbnail's pixels.
  const ZOOM_CAP = 1.2;
  const pool = aspects.map((_, i) => i);

  while (pool.length > 0) {
    const columns: { width: number; picks: number[] }[] = [];
    let x = 0;
    while (pool.length > 0 && x < width) {
      // Stack size: the count whose worst cell's diagonal lands nearest nominal.
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

      // An orphan orientation would zoom past the cap: try partners anywhere later, then a mixed column.
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

    // The overshooting column is kept or handed back to the pool, whichever leaves the smaller correction.
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

/** Greedy justified rows at or under `targetHeight`; the last row keeps the target height instead of stretching. */
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
    const last = first + count >= aspects.length;
    const height = Math.round(last && filled > targetHeight ? targetHeight : filled);

    const widths: number[] = [];
    let used = 0;
    for (let i = 0; i < count; i += 1) {
      const aspect = Math.max(0.1, aspects[first + i] ?? DEFAULT_ASPECT);
      // The final cell of a justified row absorbs the rounding so the row meets the right edge to the pixel.
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
