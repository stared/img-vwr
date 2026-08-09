import type { FileEntry, ImageMeta } from "../ipc";
import { takenMs } from "./derived";

/**
 * Scenes: runs of photographs taken close together in time.
 *
 * An event shoot arrives as hundreds of files, but it was taken as a few
 * dozen moments — a dance, a group at a table, a look outside. The gap
 * between two shutter presses says which: within a moment it is seconds,
 * between moments it is minutes. So a scene is simply a run of consecutive
 * photographs none of which is more than the chosen gap after the previous
 * one, and picking the best of a scene replaces wading through the whole
 * card.
 *
 * Computed over the visible list in its current order, not over some
 * time-sorted shadow of it: what gets section headers is what is on screen.
 * Camera files sort by name in shooting order, so the usual case is the
 * right one, and a sort that interleaves times simply produces scenes that
 * say so.
 */

/** A run of consecutive visible photographs that belong together. */
export interface Scene {
  /** Index into the visible list of the first photograph. */
  start: number;
  /** One past the last photograph. */
  end: number;
  /** When the first photograph was taken, UNIX ms. */
  startMs: number;
}

/**
 * The gaps worth offering, minutes. Cycled through by one control — a small
 * enumerable domain, so the choices are stated rather than typed. Null is
 * off: the grid is a plain contact sheet again.
 */
export const SCENE_GAPS_MIN: readonly (number | null)[] = [null, 2, 5, 15];

export function nextSceneGap(current: number | null): number | null {
  const at = SCENE_GAPS_MIN.indexOf(current);
  // An unknown value (a future stored preference, say) restarts the cycle.
  return SCENE_GAPS_MIN[(at + 1) % SCENE_GAPS_MIN.length] ?? null;
}

/** What the control says: the state, in words. */
export function sceneGapLabel(gapMin: number | null): string {
  return gapMin === null ? "scenes: off" : `scenes: ${gapMin} min gaps`;
}

/**
 * When the photograph was taken: EXIF first, the file's own clock second.
 *
 * The fallback matters more than it looks — metadata streams in after the
 * scan, and until it lands a camera file's modified time is the moment the
 * camera wrote it, which for scene purposes is the same fact.
 */
export function sceneTimeOf(entry: FileEntry, meta: Record<string, ImageMeta>): number {
  const m = meta[entry.path];
  return (m ? takenMs(m) : null) ?? entry.modifiedMs;
}

/**
 * Consecutive photographs at least this alike are one moment whatever the
 * clock says: the pause was the photographer waiting, not the scene ending.
 */
export const SCENE_MERGE_SIM = 0.92;

/**
 * Below this the content has moved on even though the shutter kept going —
 * a look outside in the middle of a table's run of frames.
 */
export const SCENE_SPLIT_SIM = 0.55;

/**
 * A dissimilar pair splits only across a pause at least this share of the
 * gap: within a burst, one odd frame (a passer-by, a flash misfire) is part
 * of the scene, not a boundary.
 */
const SPLIT_MIN_GAP_SHARE = 0.2;

/**
 * Group the visible list into scenes; a gap over `gapMs` starts a new one.
 *
 * `sims` — consecutive-pair embedding similarity, where `sims[i]` describes
 * (entries[i], entries[i+1]) — refines the clock's verdict when present:
 * near-identical content bridges a long pause, and a content jump splits a
 * run the clock would keep together. Null (or null per pair, for images not
 * yet indexed) leaves the clock's verdict alone.
 */
export function groupScenes(
  entries: FileEntry[],
  meta: Record<string, ImageMeta>,
  gapMs: number,
  sims: readonly (number | null)[] | null,
): Scene[] {
  const scenes: Scene[] = [];
  let previousMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const t = sceneTimeOf(entry, meta);
    const current = scenes[scenes.length - 1];
    // Absolute distance: a sort running newest-first walks time backwards,
    // and "close together" is the same fact in either direction.
    const gap = Math.abs(t - previousMs);
    let breaks = current === undefined || gap > gapMs;
    const sim = current === undefined ? null : (sims?.[i - 1] ?? null);
    if (sim !== null) {
      if (breaks && sim >= SCENE_MERGE_SIM) breaks = false;
      else if (!breaks && sim < SCENE_SPLIT_SIM && gap > gapMs * SPLIT_MIN_GAP_SHARE)
        breaks = true;
    }
    if (!breaks && current) {
      current.end = i + 1;
    } else {
      scenes.push({ start: i, end: i + 1, startMs: t });
    }
    previousMs = t;
  }
  return scenes;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The header a scene wears: when it started and how many photographs it
 * holds. The date appears only when it changes — within one day of shooting
 * the clock time is the fact that separates scenes.
 */
export function sceneLabel(scene: Scene, previous: Scene | null, count: number): string {
  const d = new Date(scene.startMs);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const p = previous === null ? null : new Date(previous.startMs);
  const newDay =
    p === null ||
    p.getFullYear() !== d.getFullYear() ||
    p.getMonth() !== d.getMonth() ||
    p.getDate() !== d.getDate();
  const day = newDay
    ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    : "";
  return `${day}${time} · ${count}`;
}

/** The scene holding the visible index, or null when the index is not shown. */
export function sceneAt(scenes: Scene[], index: number): number | null {
  const at = scenes.findIndex((s) => index >= s.start && index < s.end);
  return at < 0 ? null : at;
}

/**
 * Where a jump lands: the first photograph of the neighbouring scene.
 *
 * From nothing selected, forward enters the first scene and backward the
 * last — the same "enter from the end the arrow points from" the plain
 * arrows use. Past either end there is nothing to jump to.
 */
export function sceneJumpTarget(
  scenes: Scene[],
  selectedIndex: number | null,
  direction: 1 | -1,
): number | null {
  if (scenes.length === 0) return null;
  if (selectedIndex === null) {
    const landing = direction === 1 ? scenes[0] : scenes[scenes.length - 1];
    return landing?.start ?? null;
  }
  const at = sceneAt(scenes, selectedIndex);
  if (at === null) return null;
  const target = scenes[at + direction];
  return target?.start ?? null;
}
