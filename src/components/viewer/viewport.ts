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
