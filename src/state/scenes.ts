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
 * The time constant's slider range, minutes. Logarithmic: the difference
 * that matters between 30 s and a minute is the same *ratio* that matters
 * between 15 and 30 minutes, so equal slider distance means equal ratio.
 */
export const SCENE_TAU_MIN = 0.5;
export const SCENE_TAU_MAX = 60;

/** Slider position 0..1 → minutes, log scale. */
export function tauFromSlider(x: number): number {
  return SCENE_TAU_MIN * Math.pow(SCENE_TAU_MAX / SCENE_TAU_MIN, Math.min(Math.max(x, 0), 1));
}

/** Minutes → slider position 0..1. */
export function sliderFromTau(tauMin: number): number {
  const x = Math.log(tauMin / SCENE_TAU_MIN) / Math.log(SCENE_TAU_MAX / SCENE_TAU_MIN);
  return Math.min(Math.max(x, 0), 1);
}

/** How the value names itself: "~" because the minutes are a feel, not a
 * cutoff — content decides where scenes break. */
export function sceneGapLabel(gapMin: number): string {
  if (gapMin < 0.95) return `~${Math.max(5, Math.round((gapMin * 60) / 5) * 5)} s`;
  if (gapMin >= 59.5) return "~1 h";
  if (gapMin < 9.5) {
    const rounded = Math.round(gapMin * 2) / 2;
    return `~${rounded % 1 === 0 ? rounded : rounded.toFixed(1)} min`;
  }
  return `~${Math.round(gapMin)} min`;
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
 * How many earlier scene members a photograph is compared against. Wide and
 * close shots alternate within one scene; the best match among the last few
 * is the honest "does this belong here", where the single previous frame is
 * a coin toss.
 */
export const SCENE_BAND = 3;

/**
 * The similarity a photograph needs to continue the scene, as a function of
 * the pause before it.
 *
 * Shooting continuously, only a hard content change ends a scene — the
 * floor. After a long pause, only near-identical content bridges it — the
 * ceiling. In between the requirement rises smoothly, and `tauMs` (the
 * control's minutes) is the time constant of that rise: not a cutoff, but
 * how quickly a pause makes the content's continuity harder to believe.
 */
export const SCENE_SIM_FLOOR = 0.55;
export const SCENE_SIM_CEIL = 0.93;

/** A threshold no similarity reaches: with the content weight at zero this
 * is what "the clock says split" compiles to. */
const SCENE_NEVER = 1.01;

/**
 * `weight` is how much the pictures outvote the clock, 0..1. The pure-clock
 * rule IS a threshold curve — zero up to the gap, impossible past it — so
 * the weight honestly interpolates between the two models rather than
 * scaling some cosmetic knob: at 0 this reduces exactly to "a pause over
 * tau splits", at 1 content alone decides how the pause reads.
 */
export function sceneThreshold(gapMs: number, tauMs: number, weight: number): number {
  const smooth = SCENE_SIM_CEIL - (SCENE_SIM_CEIL - SCENE_SIM_FLOOR) * Math.exp(-gapMs / tauMs);
  const clock = gapMs <= tauMs ? 0 : SCENE_NEVER;
  return weight * smooth + (1 - weight) * clock;
}

/** The best similarity from `bands[i]` to members of the current scene at
 * or after `sceneStart`, skipping index `skip` (-1 for none). Null when no
 * comparison is known. */
function bestToScene(
  bands: readonly (readonly (number | null)[])[],
  i: number,
  sceneStart: number,
  skip: number,
): number | null {
  const row = bands[i];
  if (!row) return null;
  let best: number | null = null;
  for (let d = 1; d <= row.length; d += 1) {
    const j = i - d;
    if (j < sceneStart) break;
    if (j === skip) continue;
    const sim = row[d - 1];
    if (sim !== null && sim !== undefined && (best === null || sim > best)) best = sim;
  }
  return best;
}

/**
 * Group the visible list into scenes.
 *
 * Content decides, time modulates. With `bands` (each photograph's
 * similarity to the few before it), a photograph continues the scene when
 * its best match among the scene's recent members clears
 * `sceneThreshold(pause, tauMs)` — so a run of shooting splits where the
 * pictures change, however short the pause, and a long pause splits unless
 * the pictures barely moved. One odd frame never cuts a scene: a would-be
 * boundary is kept inside when the frame after it rejoins the scene over
 * its head.
 *
 * Without a model (`bands` null, or unindexed rows), the clock alone
 * decides: a pause over `tauMs` starts a new scene.
 */
export function groupScenes(
  entries: FileEntry[],
  meta: Record<string, ImageMeta>,
  tauMs: number,
  weight: number,
  bands: readonly (readonly (number | null)[])[] | null,
): Scene[] {
  const scenes: Scene[] = [];
  const times = entries.map((e) => sceneTimeOf(e, meta));
  for (let i = 0; i < entries.length; i += 1) {
    const t = times[i] ?? 0;
    const current = scenes[scenes.length - 1];
    if (current === undefined) {
      scenes.push({ start: i, end: i + 1, startMs: t });
      continue;
    }
    // Absolute distance: a sort running newest-first walks time backwards,
    // and "close together" is the same fact in either direction.
    const gap = Math.abs(t - (times[i - 1] ?? 0));
    const sim = bands ? bestToScene(bands, i, current.start, -1) : null;
    let continues: boolean;
    if (sim === null) {
      continues = gap <= tauMs;
    } else {
      continues = sim >= sceneThreshold(gap, tauMs, weight);
      if (!continues && i + 1 < entries.length && bands) {
        // The odd-frame reprieve: if the next photograph rejoins the scene
        // over this one's head (compared against the scene as it stands,
        // not against the odd frame), this frame is a passer-by inside the
        // scene, not the start of a new one.
        const nextSim = bestToScene(bands, i + 1, current.start, i);
        const nextGap = Math.abs((times[i + 1] ?? 0) - (times[i - 1] ?? 0));
        continues = nextSim !== null && nextSim >= sceneThreshold(nextGap, tauMs, weight);
      }
    }
    if (continues) {
      current.end = i + 1;
    } else {
      scenes.push({ start: i, end: i + 1, startMs: t });
    }
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
