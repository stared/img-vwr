import { FULL_REGION, type Crop, type RegionArg } from "../ipc";

/** Size in real pixels of what the viewer shows — the cropped size, or zoom percentages would be measured against thrown-away pixels. */
export function displayedSize(
  native: { width: number; height: number },
  crop: Crop,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(native.width * crop.width)),
    height: Math.max(1, Math.round(native.height * crop.height)),
  };
}

/** The frame's shape, which every rotation in `./crop` has to be told. */
export function frameAspect(native: { width: number; height: number }): number {
  return native.height > 0 ? native.width / native.height : 1;
}

/** Largest detail crop we will develop, in pixels of the longest edge. */
export const DETAIL_MAX_EDGE = 4000;

/** The region covering `edge` image pixels at 1:1 around `at`, clamped inside the frame. */
export function loupeRegion(
  at: { x: number; y: number },
  image: { width: number; height: number },
  edge: number,
): RegionArg {
  const width = Math.min(1, edge / Math.max(1, image.width));
  const height = Math.min(1, edge / Math.max(1, image.height));
  const inside = (v: number, span: number) => Math.min(1 - span, Math.max(0, v - span / 2));
  return { x: inside(at.x, width), y: inside(at.y, height), width, height };
}

/** The loupe renders this much wider than its window, so small aim movements slide over pixels already in hand. */
export const LOUPE_MARGIN = 1.8;

/** Whether pixels covering `have` can still fill a window over `want`. */
export function loupeCovers(have: RegionArg, want: RegionArg): boolean {
  // A pixel of slack: the regions are computed in floats from different sizes.
  const EPS = 1e-6;
  return (
    want.x >= have.x - EPS &&
    want.y >= have.y - EPS &&
    want.x + want.width <= have.x + have.width + EPS &&
    want.y + want.height <= have.y + have.height + EPS
  );
}

/** How much two regions must differ before the crop is worth re-developing. */
const REGION_EPSILON = 0.01;

export function regionsDiffer(a: RegionArg, b: RegionArg): boolean {
  return (
    Math.abs(a.x - b.x) > REGION_EPSILON ||
    Math.abs(a.y - b.y) > REGION_EPSILON ||
    Math.abs(a.width - b.width) > REGION_EPSILON ||
    Math.abs(a.height - b.height) > REGION_EPSILON
  );
}

/** On-screen part in normalised image coordinates; `scale` is screen pixels per image pixel, `tx`/`ty` place the image's top-left. */
export function visibleRegion(
  view: { scale: number; tx: number; ty: number },
  image: { width: number; height: number },
  canvas: { width: number; height: number },
): RegionArg {
  const spanX = view.scale * image.width;
  const spanY = view.scale * image.height;
  if (spanX <= 0 || spanY <= 0) return FULL_REGION;
  const x = Math.max(0, -view.tx / spanX);
  const y = Math.max(0, -view.ty / spanY);
  return {
    x,
    y,
    width: Math.min(1 - x, canvas.width / spanX),
    height: Math.min(1 - y, canvas.height / spanY),
  };
}

/** True when the preview is magnified past its own resolution. */
export function needsDetail(
  view: { scale: number },
  frame: { width: number },
  image: { width: number },
): boolean {
  if (image.width <= 0 || frame.width <= 0) return false;
  const previewPixelsPerImagePixel = frame.width / image.width;
  // Slack so sitting exactly at the preview's resolution does not flap.
  return view.scale > previewPixelsPerImagePixel * 1.05;
}

/** Bounded so a huge window does not turn every drag into a full-resolution render. */
export function previewEdge(viewportLongestPx: number, dpr: number): number {
  const wanted = Math.round(viewportLongestPx * dpr);
  return Math.min(3000, Math.max(1200, wanted));
}
