import type { Crop } from "../ipc";

/**
 * Crop geometry, the way a darkroom means it.
 *
 * The stored rectangle (`Crop`) is axis-aligned in a frame turned by `angle`,
 * which is the only representation that makes a straightened crop meaningful.
 * That representation is awkward to point at, though — the user is dragging a
 * corner on a screen, not editing a rotated coordinate system — so everything
 * here is the translation between the two.
 *
 * The rule every function obeys: **a crop never contains anything that is not
 * in the frame.** Rotating a rectangle sweeps its corners outside the picture,
 * and a renderer asked for pixels that were never recorded can only invent
 * them — which it did, by clamping at the edge, producing a smeared border
 * that looked like a bad decode. Lightroom solves this by shrinking the crop
 * as you straighten, so straightening always costs you edges and never costs
 * you the picture; `fitted` is that, in closed form.
 *
 * ## The two spaces
 *
 * Normalised coordinates are not isotropic — a 3:2 frame stretches x by 1.5 —
 * so an angle only means what it looks like in a *square* space. Every
 * rotation here converts by the frame's aspect, turns, and converts back. The
 * same care as `crop.rs`, because the two must agree exactly: this side draws
 * the rectangle, that side renders it.
 */

/** Smallest crop that is an intention rather than a slip. Matches `crop.rs`. */
export const MIN_EXTENT = 0.02;

/** Beyond this a "crop" is a rotation of the whole picture. Matches `crop.rs`. */
export const MAX_ANGLE = 45;

export interface Point {
  x: number;
  y: number;
}

function centreOf(crop: Crop): Point {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}

/**
 * A point given as an offset from the crop's centre in the turned frame,
 * expressed in the original frame's normalised coordinates.
 *
 * The mirror of `Crop::rotated_to_original` in `crop.rs`, and it must stay
 * one: this places the rectangle the user sees, that renders the pixels.
 */
export function rotatedToOriginal(crop: Crop, dx: number, dy: number, aspect: number): Point {
  const c = centreOf(crop);
  const t = (crop.angle * Math.PI) / 180;
  const [sin, cos] = [Math.sin(t), Math.cos(t)];
  const [ix, iy] = [dx * aspect, dy];
  return { x: c.x + (ix * cos - iy * sin) / aspect, y: c.y + (ix * sin + iy * cos) };
}

/** The way back: where a point of the frame sits relative to the crop's centre
 * in the turned frame. What a pointer on screen has to be turned into. */
export function originalToRotated(crop: Crop, x: number, y: number, aspect: number): Point {
  const c = centreOf(crop);
  const t = (crop.angle * Math.PI) / 180;
  const [sin, cos] = [Math.sin(t), Math.cos(t)];
  const [ix, iy] = [(x - c.x) * aspect, y - c.y];
  return { x: (ix * cos + iy * sin) / aspect, y: -ix * sin + iy * cos };
}

/** The crop's four corners, in the original frame's coordinates. */
export function cornersOf(crop: Crop, aspect: number): Point[] {
  const [hw, hh] = [crop.width / 2, crop.height / 2];
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => rotatedToOriginal(crop, dx as number, dy as number, aspect));
}

/**
 * The axis-aligned extent a turned rectangle needs, in normalised coordinates.
 *
 * Closed form rather than four corners and a min/max, because it is linear in
 * the rectangle's size — which is exactly what lets `fitted` compute the
 * scale that makes a crop fit instead of searching for it.
 */
function spanOf(crop: Crop, aspect: number): { width: number; height: number } {
  const t = (crop.angle * Math.PI) / 180;
  const [sin, cos] = [Math.abs(Math.sin(t)), Math.abs(Math.cos(t))];
  const [w, h] = [crop.width * aspect, crop.height];
  return { width: (w * cos + h * sin) / aspect, height: w * sin + h * cos };
}

/**
 * The nearest crop that lies entirely inside the frame: shrunk about its own
 * centre if it has to be, then slid back in.
 *
 * Shrinking keeps the rectangle's shape, so a locked aspect survives being
 * straightened, and sliding comes second so a crop that merely wandered off
 * an edge is moved rather than made smaller. Every function in this module
 * ends with a call to it, which is what makes "the crop is always inside the
 * frame" an invariant rather than a hope.
 */
export function fitted(crop: Crop, aspect: number): Crop {
  const angle = clampFinite(crop.angle, -MAX_ANGLE, MAX_ANGLE);
  // Floored but deliberately not capped at the frame. An oversized rectangle
  // is brought back by the proportional shrink below, which is what keeps a
  // locked shape locked; capping each extent at 1 separately would quietly
  // square off a 16:9 crop that had been dragged too far.
  const width = atLeast(crop.width, MIN_EXTENT);
  const height = atLeast(crop.height, MIN_EXTENT);
  const c = centreOf({ ...crop, width, height });
  const held = {
    x: clampFinite(c.x, 0, 1) - width / 2,
    y: clampFinite(c.y, 0, 1) - height / 2,
    width,
    height,
    angle,
  };

  // One proportional shrink is exact — the span is linear in the size — and
  // the loop is only for the degenerate case where the minimum extent stops
  // one side from shrinking with the other, so the shape can no longer be
  // held and the remaining overflow has to be taken off again.
  let shrunk = held;
  for (let pass = 0; pass < 4; pass += 1) {
    const span = spanOf(shrunk, aspect);
    const scale = Math.min(1, 1 / Math.max(span.width, 1e-6), 1 / Math.max(span.height, 1e-6));
    if (scale >= 1) break;
    shrunk = {
      ...shrunk,
      width: Math.max(MIN_EXTENT, shrunk.width * scale),
      height: Math.max(MIN_EXTENT, shrunk.height * scale),
    };
  }

  // Slid back in by its own extent, which is the turned one — an unturned
  // crop's span is simply its size, so this is an ordinary clamp there.
  const s = spanOf(shrunk, aspect);
  const centre = centreOf(shrunk);
  const inside = (v: number, span: number) =>
    span >= 1 ? 0.5 : Math.min(1 - span / 2, Math.max(span / 2, v));
  const cx = inside(centre.x, s.width);
  const cy = inside(centre.y, s.height);
  return {
    x: cx - shrunk.width / 2,
    y: cy - shrunk.height / 2,
    width: shrunk.width,
    height: shrunk.height,
    angle,
  };
}

/** The whole frame, unturned — what "no crop" is. */
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1, angle: 0 };

export function isCropped(crop: Crop): boolean {
  return (
    crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1 || crop.angle !== 0
  );
}

/**
 * Straighten: turn the frame under the rectangle, and give back as much of it
 * as still fits.
 *
 * Turning the rectangle instead would leave the horizon crooked and the
 * rectangle crooked with it, which is unjudgeable — you would have to tilt
 * your head to see whether you had got it straight. Every editor that has
 * thought about this turns the picture and holds the rectangle level.
 */
export function straightened(crop: Crop, angle: number, aspect: number): Crop {
  return fitted({ ...crop, angle }, aspect);
}

/** The crop moved by a pointer delta given in the turned frame. */
export function moved(crop: Crop, dx: number, dy: number, aspect: number): Crop {
  const c = rotatedToOriginal(crop, dx, dy, aspect);
  return fitted(
    { ...crop, x: c.x - crop.width / 2, y: c.y - crop.height / 2 },
    aspect,
  );
}

/** The eight places a crop can be taken hold of, plus the inside. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type Handle = (typeof HANDLES)[number];

const PULLS: Record<Handle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

/**
 * A handle dragged to a point, given as an offset from the crop's centre in
 * the turned frame.
 *
 * The opposite edge stays where it is — which is what makes a crop feel like a
 * rectangle being pulled rather than one being re-drawn. A locked `ratio`
 * (output width over height, so it already accounts for the frame's aspect)
 * derives the edges the handle did not touch.
 */
export function resized(
  crop: Crop,
  handle: Handle,
  at: Point,
  aspect: number,
  ratio: number | null,
): Crop {
  const pull = PULLS[handle];
  let [left, right] = [-crop.width / 2, crop.width / 2];
  let [top, bottom] = [-crop.height / 2, crop.height / 2];

  if (pull.x < 0) left = Math.min(at.x, right - MIN_EXTENT);
  if (pull.x > 0) right = Math.max(at.x, left + MIN_EXTENT);
  if (pull.y < 0) top = Math.min(at.y, bottom - MIN_EXTENT);
  if (pull.y > 0) bottom = Math.max(at.y, top + MIN_EXTENT);

  let width = right - left;
  let height = bottom - top;

  if (ratio !== null) {
    // Which dimension the drag decided, and which one follows from the ratio:
    // a side handle only ever decided its own, and a corner decides whichever
    // it moved further in.
    const wanted = width / Math.max(height, 1e-6) > ratio / aspect;
    const follows = pull.x === 0 ? "width" : pull.y === 0 ? "height" : wanted ? "height" : "width";
    if (follows === "height") {
      height = (width * aspect) / ratio;
      // Grown about the edge the handle is on, so the anchored side holds.
      if (pull.y < 0) top = bottom - height;
      else if (pull.y > 0) bottom = top + height;
      else [top, bottom] = [-height / 2, height / 2];
    } else {
      width = (height * ratio) / aspect;
      if (pull.x < 0) left = right - width;
      else if (pull.x > 0) right = left + width;
      else [left, right] = [-width / 2, width / 2];
    }
  }

  const centre = rotatedToOriginal(crop, (left + right) / 2, (top + bottom) / 2, aspect);
  return fitted(
    { x: centre.x - width / 2, y: centre.y - height / 2, width, height, angle: crop.angle },
    aspect,
  );
}

/**
 * A rectangle dragged out from nothing, both points given in the turned frame
 * relative to the current crop's centre.
 *
 * Either corner may be the one dragged to, so it is built from the extremes.
 * The angle rides along untouched: drawing a new rectangle on a straightened
 * photograph is choosing a different part of it, not un-straightening it.
 */
export function drawn(crop: Crop, from: Point, to: Point, aspect: number): Crop {
  const width = Math.max(MIN_EXTENT, Math.abs(to.x - from.x));
  const height = Math.max(MIN_EXTENT, Math.abs(to.y - from.y));
  const centre = rotatedToOriginal(
    crop,
    (from.x + to.x) / 2,
    (from.y + to.y) / 2,
    aspect,
  );
  return fitted(
    { x: centre.x - width / 2, y: centre.y - height / 2, width, height, angle: crop.angle },
    aspect,
  );
}

/**
 * The shapes a crop is usually asked for.
 *
 * "free" and "as shot" are not really ratios and are listed anyway, because
 * the question the row answers is "what shape is this photograph", and those
 * are two of the answers. Everything else is named the way a photographer says
 * it, not as a decimal.
 */
export interface AspectChoice {
  id: string;
  label: string;
  /** Width over height, or null for free / the frame's own. */
  ratio: number | null;
}

export const ASPECT_CHOICES: readonly AspectChoice[] = [
  { id: "free", label: "free", ratio: null },
  { id: "original", label: "as shot", ratio: null },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "5:4", label: "5:4", ratio: 5 / 4 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

/** What a choice means for a frame of this shape, in the orientation asked
 * for. "as shot" is the frame's own ratio; "free" is no constraint at all. */
export function ratioOf(
  choice: AspectChoice,
  aspect: number,
  portrait: boolean,
): number | null {
  if (choice.id === "free") return null;
  const ratio = choice.id === "original" ? aspect : choice.ratio;
  if (ratio === null) return null;
  return portrait ? 1 / ratio : ratio;
}

/** The crop reshaped to a ratio, keeping its centre and as much of it as the
 * new shape allows — never growing, so a constraint can only ever take. */
export function withRatio(crop: Crop, ratio: number | null, aspect: number): Crop {
  if (ratio === null) return fitted(crop, aspect);
  const height = Math.min(crop.height, (crop.width * aspect) / ratio);
  const width = (height * ratio) / aspect;
  const centre = centreOf(crop);
  return fitted(
    { x: centre.x - width / 2, y: centre.y - height / 2, width, height, angle: crop.angle },
    aspect,
  );
}

/** The ratio a crop is actually sitting on, as the output would measure it. */
export function ratioIn(crop: Crop, aspect: number): number {
  return (crop.width * aspect) / Math.max(crop.height, 1e-6);
}

/** Whether a crop stands taller than it is wide, which is the only thing
 * "portrait" means here. */
export function isPortrait(crop: Crop, aspect: number): boolean {
  return ratioIn(crop, aspect) < 1;
}

/** A finite number no smaller than `floor` — a size, sanitised. */
function atLeast(v: number, floor: number): number {
  return Number.isFinite(v) && v > floor ? v : floor;
}

function clampFinite(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
