import type { Crop } from "../ipc";

/** `Crop` is axis-aligned in a frame turned by `angle`; rotations convert through the frame's aspect and must agree exactly with `crop.rs`. */

/** Smallest crop that is an intention rather than a slip. Matches `crop.rs`. */
export const MIN_EXTENT = 0.02;

/** Beyond this a "crop" is a rotation of the whole picture. Matches `crop.rs`. */
const MAX_ANGLE = 45;

export interface Point {
  x: number;
  y: number;
}

function centreOf(crop: Crop): Point {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}

/** Offset from the crop's centre in the turned frame → original-frame coordinates; must mirror `Crop::rotated_to_original` in `crop.rs`. */
export function rotatedToOriginal(crop: Crop, dx: number, dy: number, aspect: number): Point {
  const c = centreOf(crop);
  const t = (crop.angle * Math.PI) / 180;
  const [sin, cos] = [Math.sin(t), Math.cos(t)];
  const [ix, iy] = [dx * aspect, dy];
  return { x: c.x + (ix * cos - iy * sin) / aspect, y: c.y + (ix * sin + iy * cos) };
}

/** The inverse: frame point → offset from the crop's centre in the turned frame. */
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

/** Axis-aligned extent of the turned rectangle; linear in its size, which lets `fitted` solve the fitting scale in closed form. */
function spanOf(crop: Crop, aspect: number): { width: number; height: number } {
  const t = (crop.angle * Math.PI) / 180;
  const [sin, cos] = [Math.abs(Math.sin(t)), Math.abs(Math.cos(t))];
  const [w, h] = [crop.width * aspect, crop.height];
  return { width: (w * cos + h * sin) / aspect, height: w * sin + h * cos };
}

/** Nearest crop entirely inside the frame: shrunk about its centre (keeps a locked shape), then slid in; every mutator here ends with it. */
export function fitted(crop: Crop, aspect: number): Crop {
  const angle = clampFinite(crop.angle, -MAX_ANGLE, MAX_ANGLE);
  // Not capped at 1 per side: the proportional shrink below keeps a locked shape; per-side caps would square it off.
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

  // One proportional shrink is exact; the loop only handles MIN_EXTENT stopping one side from shrinking with the other.
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

export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1, angle: 0 };

export function isCropped(crop: Crop): boolean {
  return (
    crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1 || crop.angle !== 0
  );
}

/** Turns the frame under a level rectangle, keeping as much of it as still fits. */
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

/** `at` is an offset from the crop's centre in the turned frame; `ratio` is output width over height (already aspect-adjusted). */
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
    // A side handle only decided its own dimension; a corner decides whichever it moved further in.
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

/** Both points are in the turned frame relative to the current crop's centre; the angle rides along untouched. */
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

interface AspectChoice {
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

/** "as shot" is the frame's own ratio; "free" is null, no constraint. */
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

/** Reshapes to the ratio about the crop's centre, never growing. */
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

export function isPortrait(crop: Crop, aspect: number): boolean {
  return ratioIn(crop, aspect) < 1;
}

function atLeast(v: number, floor: number): number {
  return Number.isFinite(v) && v > floor ? v : floor;
}

function clampFinite(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
