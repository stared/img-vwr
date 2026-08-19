import type { FileEntry, ImageMeta } from "../ipc";
import { isRawEntry, stackKeyOf } from "./stacks";

/** EXIF timestamps resolve whole seconds, so 2000 ms means the same second or the next. */
const MAX_GAP_MS = 2000;

/** A pair with an exposure step is more often a corrected mistake than a bracket. */
const MIN_FRAMES = 3;

/** In EV; less sweep than this is auto-exposure jitter, not a bracket. */
export const MIN_SPREAD = 1.5;

export interface HdrSet {
  /** In shot order. */
  frames: FileEntry[];
  /** The middle exposure; this path is the fused photograph's name. */
  face: FileEntry;
  /** EV between the darkest and brightest frame. */
  spread: number;
}

/** EV at ISO 100; only inter-frame differences matter, so a missing aperture falls back to a constant. */
export function exposureValue(exif: {
  exposureTime: number | null;
  fNumber: number | null;
  iso: number | null;
}): number | null {
  if (exif.exposureTime === null || exif.exposureTime <= 0) return null;
  const aperture = exif.fNumber ?? 1;
  const iso = exif.iso ?? 100;
  return Math.log2((aperture * aperture) / exif.exposureTime) - Math.log2(iso / 100);
}

/** EXIF datetime → ms; accepts ":" or "-" date separators, zone ignored (values are only subtracted). */
export function takenMs(dateTime: string | null): number | null {
  if (dateTime === null) return null;
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

interface Measured {
  entry: FileEntry;
  at: number;
  ev: number;
  focal: number | null;
}

/** Answers from whatever metadata has arrived; the caller re-runs as batches land. */
export function hdrSetsOf(
  entries: readonly FileEntry[],
  metaOf: (path: string) => ImageMeta | null,
): HdrSet[] {
  // An exported merge carries a source frame's EXIF verbatim and would join the burst it was made from.
  const seen = new Set<string>();
  const jpegs: FileEntry[] = [];
  for (const entry of entries) {
    if (isRawEntry(entry) || MERGED.test(stemOf(entry.name))) continue;
    const key = stackKeyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    jpegs.push(entry);
  }

  const measured: Measured[] = [];
  for (const entry of jpegs) {
    const exif = metaOf(entry.path)?.exif;
    if (!exif) continue;
    const at = takenMs(exif.dateTime);
    const ev = exposureValue(exif);
    if (at === null || ev === null) continue;
    measured.push({ entry, at, ev, focal: exif.focalLength });
  }
  measured.sort((a, b) => a.at - b.at || a.entry.name.localeCompare(b.entry.name));

  const sets: HdrSet[] = [];
  let burst: Measured[] = [];
  const close = () => {
    const set = hdrSetFrom(burst);
    if (set) sets.push(set);
    burst = [];
  };
  for (const frame of measured) {
    const last = burst[burst.length - 1];
    if (last !== undefined && frame.at - last.at > MAX_GAP_MS) close();
    burst.push(frame);
  }
  close();
  return sets;
}

function hdrSetFrom(burst: Measured[]): HdrSet | null {
  if (burst.length < MIN_FRAMES) return null;
  // Frames without a focal length get the benefit of the doubt.
  const focals = burst.map((f) => f.focal).filter((f): f is number => f !== null);
  if (focals.some((f) => Math.abs(f - (focals[0] ?? f)) > 0.5)) return null;
  const evs = burst.map((f) => f.ev);
  const spread = Math.max(...evs) - Math.min(...evs);
  if (spread < MIN_SPREAD) return null;
  // Middle of the sweep — the frame the merge's alignment anchors on.
  const byEv = [...burst].sort((a, b) => a.ev - b.ev);
  const face = byEv[Math.floor(byEv.length / 2)]?.entry;
  if (face === undefined) return null;
  return { frames: burst.map((f) => f.entry), face, spread };
}

/** What the develop service is told: face path → the frames to fuse. */
export function fusionMap(sets: readonly HdrSet[]): Record<string, string[]> {
  return Object.fromEntries(sets.map((s) => [s.face.path, s.frames.map((f) => f.path)]));
}

export function hdrLabel(set: HdrSet): string {
  return `HDR ×${set.frames.length} · ${set.spread.toFixed(1)} EV`;
}

/** Matches exported merge output names, so a set never forms around one. */
const MERGED = /-HDR(-\d+)?$/;

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
