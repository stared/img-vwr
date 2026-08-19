import type { ImageMeta } from "../ipc";

export interface Dims {
  width: number;
  height: number;
}

interface GeoPoint {
  lat: number;
  lon: number;
}

export function gpsOf(meta: ImageMeta | undefined): GeoPoint | null {
  const lat = meta?.exif?.gpsLat;
  const lon = meta?.exif?.gpsLon;
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  // Exact (0, 0) is Null Island — cameras write it as "no fix", never as a photo spot.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Parse an EXIF datetime ("2023:05:12 14:33:21", also "-" separators) → ms, or null. */
export function parseExifDate(value: string): number | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isFinite(t) && Number(y) > 0 ? t : null;
}

/** Display dimensions: EXIF orientations 5–8 mean the pixels are stored rotated. */
export function effectiveDims(meta: ImageMeta): Dims | null {
  if (meta.width === null || meta.height === null) return null;
  const swapped = (meta.exif?.orientation ?? 1) >= 5;
  return swapped
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

export function takenMs(meta: ImageMeta): number | null {
  return meta.exif?.dateTime ? parseExifDate(meta.exif.dateTime) : null;
}

const NAMED_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "5:4", value: 5 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:10", value: 16 / 10 },
  { label: "16:9", value: 16 / 9 },
  { label: "2:1", value: 2 },
] as const;

const RATIO_TOLERANCE = 0.04;

/** Nearest named ratio of long/short edge, or the "wider"/"other" catch-alls. */
export function aspectLabelOf({ width, height }: Dims): string | null {
  if (width <= 0 || height <= 0) return null;
  const ratio = Math.max(width, height) / Math.min(width, height);
  let best: { label: string; error: number } | null = null;
  for (const named of NAMED_RATIOS) {
    const error = Math.abs(ratio - named.value) / named.value;
    if (error <= RATIO_TOLERANCE && (best === null || error < best.error)) {
      best = { label: named.label, error };
    }
  }
  return best?.label ?? (ratio > 2 ? "wider" : "other");
}
