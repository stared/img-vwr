/**
 * Pure zoom/pan math for the image viewer.
 * Screen coords = image coords * scale + (tx, ty).
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 40;

/** Center the image in the window, downscaling to fit but never upscaling. */
export function fitToWindow(img: Size, win: Size): Viewport {
  if (img.width <= 0 || img.height <= 0 || win.width <= 0 || win.height <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = Math.min(1, win.width / img.width, win.height / img.height);
  return centered(img, win, scale);
}

/** 100% scale, centered (or clamped if larger than the window). */
export function actualSize(img: Size, win: Size): Viewport {
  return clampPan(centered(img, win, 1), img, win);
}

function centered(img: Size, win: Size, scale: number): Viewport {
  return {
    scale,
    tx: (win.width - img.width * scale) / 2,
    ty: (win.height - img.height * scale) / 2,
  };
}

/**
 * The same magnification, on the same part of the frame, for a different
 * image — what stepping to the next take should do once you have zoomed in.
 *
 * Scale is screen pixels per image pixel, so carrying it across means 100%
 * stays 100% and two frames from the same camera are magnified identically.
 * Position is carried as a fraction of the frame rather than in pixels,
 * because the useful invariant is "the middle of the window is still looking
 * at the eyes", and that survives a differently sized or cropped neighbour.
 */
export function heldView(prev: Viewport, prevImg: Size, next: Size, win: Size): Viewport {
  if (prevImg.width <= 0 || prevImg.height <= 0 || prev.scale <= 0) {
    return fitToWindow(next, win);
  }
  const cx = (win.width / 2 - prev.tx) / (prev.scale * prevImg.width);
  const cy = (win.height / 2 - prev.ty) / (prev.scale * prevImg.height);
  return clampPan(
    {
      scale: prev.scale,
      tx: win.width / 2 - cx * prev.scale * next.width,
      ty: win.height / 2 - cy * prev.scale * next.height,
    },
    next,
    win,
  );
}

/** Zoom by `factor` keeping the image point under `cursor` fixed on screen. */
export function zoomAtPoint(view: Viewport, cursor: Point, factor: number): Viewport {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = scale / view.scale;
  return {
    scale,
    tx: cursor.x - (cursor.x - view.tx) * ratio,
    ty: cursor.y - (cursor.y - view.ty) * ratio,
  };
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * Keep the image on screen: axes where the image is smaller than the window
 * are centered; larger axes clamp so no gap opens past an edge.
 */
export function clampPan(view: Viewport, img: Size, win: Size): Viewport {
  const w = img.width * view.scale;
  const h = img.height * view.scale;
  return {
    scale: view.scale,
    tx: w <= win.width ? (win.width - w) / 2 : clamp(view.tx, win.width - w, 0),
    ty: h <= win.height ? (win.height - h) / 2 : clamp(view.ty, win.height - h, 0),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The magnification, as the user would say it.
 *
 * "fit" and "100%" are names, not numbers — a photographer asks for the whole
 * frame or for actual pixels, and the percentage that happens to correspond
 * to "the whole frame" in this window is not information. Anything else was
 * arrived at by pinching, and there the number is the only honest answer.
 */
export function zoomLabel(view: { scale: number } | null, fitted: boolean): string {
  if (fitted || !view) return "fit";
  const percent = Math.round(view.scale * 100);
  return percent === 100 ? "100%" : `${percent}%`;
}
