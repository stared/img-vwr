import type { FileEntry, ImageMeta } from "../ipc";
import { isRawEntry, stackKeyOf } from "./stacks";

/**
 * Finding the HDR sets in a folder — and saying which file fronts each one.
 *
 * An HDR set is an exposure bracket: the same scene shot seconds apart with
 * the exposure swept stops apart. Detection needs two facts together,
 * neither sufficient alone. The frames are seconds apart — a bracket is
 * shot in one burst, hands on the camera — and their exposures *sweep*: a
 * burst without the sweep is continuous shooting (auto-ISO drift can vary a
 * third of a stop without anybody bracketing anything); a sweep without the
 * burst is somebody changing their mind between shots.
 *
 * What a set *is* to the rest of the app: one photograph. Its face — the
 * middle exposure, the frame with the most to say in both directions — is
 * the path the photograph lives behind: the develop service is told to open
 * that path as the fusion of all the frames, edits store against it, export
 * renders it. The merge is virtual; no file exists until an export writes
 * one, which is the same bargain every edit in this app makes.
 *
 * Detection reads the camera's JPEGs, one per stack — they are what the
 * fusion decodes, so they are what it is planned over.
 */

/** Frames further apart than this are separate moments, not one burst. EXIF
 * timestamps resolve whole seconds, so "the same second or the next". */
export const MAX_GAP_MS = 2000;

/** Fewer frames than this is a pair, and a pair with an exposure step is
 * more often a corrected mistake than a bracket. */
export const MIN_FRAMES = 3;

/** Less sweep than this, in EV, is auto-exposure jitter — fusing it would
 * produce the same photograph, slower. */
export const MIN_SPREAD = 1.5;

/** One detected set: the frames to fuse, in the order they were shot, and
 * the face the fused photograph lives behind. */
export interface HdrSet {
  frames: FileEntry[];
  /** The middle exposure. Alignment anchors here, and so does everything
   * else: this path is the fused photograph's name. */
  face: FileEntry;
  /** EV between the darkest and brightest frame. */
  spread: number;
}

/**
 * The exposure value of one frame, ISO-adjusted (EV at ISO 100).
 *
 * Only the *differences* between frames matter here, so a missing aperture
 * falls back to a constant — within one burst on one lens it is the shutter
 * and the ISO that move. A missing shutter is disqualifying: there is no
 * exposure to compare.
 */
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

/**
 * When the frame was taken, from the EXIF date string.
 *
 * Parsed by hand: EXIF writes "2026:08:12 17:35:34" and the reader displays
 * it with dashes, so both separators are accepted. The zone is unknown and
 * irrelevant — these numbers are only ever subtracted from each other.
 */
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

/**
 * The HDR sets among these files, from whatever metadata has arrived.
 *
 * Files whose metadata is still on its way are simply not considered yet —
 * the caller re-runs this as batches land, and the answer grows. That is
 * the same bargain the export dialog's size label makes: answer from what
 * is known rather than wait for the slowest file in the folder.
 */
export function hdrSetsOf(
  entries: readonly FileEntry[],
  metaOf: (path: string) => ImageMeta | null,
): HdrSet[] {
  // One JPEG per photograph: the raw beside it is the same frame again. A
  // file whose name says it is already somebody's merge is no frame at all
  // — it carries a source frame's EXIF verbatim, and counted as one it
  // would join the very burst it was made from.
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

/** Judge one burst: enough frames, one focal length, a real sweep. */
function hdrSetFrom(burst: Measured[]): HdrSet | null {
  if (burst.length < MIN_FRAMES) return null;
  // A zoom mid-burst means the frames are not one picture. Frames that did
  // not say their focal length are given the benefit of the doubt.
  const focals = burst.map((f) => f.focal).filter((f): f is number => f !== null);
  if (focals.some((f) => Math.abs(f - (focals[0] ?? f)) > 0.5)) return null;
  const evs = burst.map((f) => f.ev);
  const spread = Math.max(...evs) - Math.min(...evs);
  if (spread < MIN_SPREAD) return null;
  // The face: middle of the sweep. The frame that shares structure with
  // both ends, which is also what the alignment inside the merge anchors on.
  const byEv = [...burst].sort((a, b) => a.ev - b.ev);
  const face = byEv[Math.floor(byEv.length / 2)]?.entry;
  if (face === undefined) return null;
  return { frames: burst.map((f) => f.entry), face, spread };
}

/** What the develop service is told: face path → the frames to fuse. */
export function fusionMap(sets: readonly HdrSet[]): Record<string, string[]> {
  return Object.fromEntries(sets.map((s) => [s.face.path, s.frames.map((f) => f.path)]));
}

/** How an HDR photograph names itself, where a caption has room for it. */
export function hdrLabel(set: HdrSet): string {
  return `HDR ×${set.frames.length} · ${set.spread.toFixed(1)} EV`;
}

/** What a merge names its output — recognised so a set is never detected
 * around somebody's already-exported merge. */
const MERGED = /-HDR(-\d+)?$/;

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
