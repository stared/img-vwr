import type { ExifSource, ExportFormat, ExportJob, ExportSize, FileEntry } from "../ipc";
import { isRawEntry, stackKeyOf } from "./stacks";

/**
 * Deciding what an export actually does to each photograph.
 *
 * Pure, and separate from the dialog that shows it, because the interesting
 * part of an export is not the file writing — it is the answer to "and what
 * will that do to these hundred frames". The dialog puts that answer on screen
 * before anything is written, which is only possible if it can be computed
 * without writing anything.
 *
 * ## Why an untouched raw exports as the camera's JPEG
 *
 * A shoot in raw + JPEG is mostly frames nobody edited. Developing those from
 * the sensor is both slow (seconds each, against a file copy) and *wrong* in a
 * way that is easy to miss: it produces this app's rendering of the raw, not
 * the one the camera made and the photographer already judged the frame by. So
 * where a photograph has no edit and a JPEG of it exists, the JPEG is the
 * export — copied, byte for byte where the size allows.
 *
 * It is a choice and not a rule, because the other reading is legitimate:
 * exporting a set that must look consistent means rendering every frame
 * through the same pipeline, camera JPEG or not.
 */

/** How an export treats a photograph nobody has edited. */
export type UneditedPolicy = "camera-jpg" | "render";

export interface ExportOptions {
  format: ExportFormat;
  size: ExportSize;
  unedited: UneditedPolicy;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  format: { kind: "jpeg", quality: 90 },
  size: { kind: "full" },
  unedited: "camera-jpg",
};

/** One photograph, with everything the plan needs to know about it. */
export interface Candidate {
  /** The file on screen — what the user picked. */
  entry: FileEntry;
  /** Every file of this photograph, the raw and the JPEG alike. */
  stack: FileEntry[];
  /** True when this photograph has a stored edit. */
  edited: boolean;
}

/** A job, and why it is that job — the dialog explains itself with this. */
export interface Planned {
  entry: FileEntry;
  job: ExportJob;
  reason: "edited" | "camera-jpg" | "no-jpg" | "always-render";
}

/** The JPEG of this photograph, if the camera wrote one. */
export function jpegOf(candidate: Candidate): FileEntry | null {
  return candidate.stack.find((f) => !isRawEntry(f)) ?? null;
}

/**
 * What will happen to one photograph.
 *
 * The rule, in order: an edited photograph is always rendered, because the
 * edit is the thing being exported. An untouched one takes the camera's JPEG
 * when the policy asks for it and there is one. Everything else renders.
 *
 * A rendered frame is given the JPEG's metadata where there is a JPEG: the
 * pipeline produces pixels, not a file that remembers a camera, and the frame
 * beside it on the card knows the date, the lens and the exposure.
 */
export function planFor(candidate: Candidate, options: ExportOptions): Planned {
  const { entry } = candidate;
  const jpeg = jpegOf(candidate);
  const exif: ExifSource = jpeg ? { kind: "file", path: jpeg.path } : { kind: "none" };
  const render = (reason: Planned["reason"]): Planned => ({
    entry,
    reason,
    job: { kind: "render", path: entry.path, exif },
  });

  if (candidate.edited) return render("edited");
  if (options.unedited === "render") return render("always-render");
  // A PNG export has no camera JPEG to hand over: copying one would be
  // ignoring the format that was asked for.
  if (options.format.kind === "png") return render("always-render");
  if (!jpeg) return render("no-jpg");
  return { entry, reason: "camera-jpg", job: { kind: "copy", path: jpeg.path } };
}

export function planAll(candidates: Candidate[], options: ExportOptions): Planned[] {
  return candidates.map((c) => planFor(c, options));
}

/** How many of each kind, for the line that says what the export will do. */
export function summarise(planned: Planned[]): { copied: number; rendered: number } {
  const copied = planned.filter((p) => p.job.kind === "copy").length;
  return { copied, rendered: planned.length - copied };
}

/**
 * The summary in words.
 *
 * Said before the export runs, because "9 of these will be the camera's own
 * JPEG" is exactly the fact a photographer wants to check, and finding it out
 * afterwards from a folder of files is finding it out too late.
 */
export function summaryOf(planned: Planned[]): string {
  const { copied, rendered } = summarise(planned);
  const photographs = planned.length === 1 ? "1 photograph" : `${planned.length} photographs`;
  if (planned.length === 0) return "nothing selected";
  if (copied === 0) return `${photographs}, all developed`;
  if (rendered === 0) return `${photographs}, all copied from the camera's JPG`;
  return `${photographs}: ${rendered} developed, ${copied} copied from the camera's JPG`;
}

/** The stack a photograph belongs to, from the whole scan. */
export function candidatesOf(
  chosen: FileEntry[],
  all: FileEntry[],
  edited: ReadonlySet<string>,
): Candidate[] {
  const byKey = new Map<string, FileEntry[]>();
  for (const entry of all) {
    const key = stackKeyOf(entry);
    const members = byKey.get(key);
    if (members) members.push(entry);
    else byKey.set(key, [entry]);
  }
  return chosen.map((entry) => {
    const stack = byKey.get(stackKeyOf(entry)) ?? [entry];
    return {
      entry,
      stack,
      // A photograph is edited when any of its files is: the raw and the JPEG
      // are one frame, and the edit was made on whichever one was on screen.
      edited: stack.some((f) => edited.has(f.path)),
    };
  });
}

/*
 * Size is a continuous quantity, so it is dragged rather than chosen from a
 * short list — somebody who wants 1600 px should not have to take 2048.
 *
 * Logarithmic, because that is how the numbers are spaced in practice: the
 * step from 512 to 1024 is the same *kind* of step as the one from 4096 to
 * 8192, and a linear track would spend three quarters of its length on sizes
 * nobody picks. Rounded to a multiple of 16, so the readout is a number a
 * person would say and a hair of thumb movement is not a different export.
 *
 * The far end is "full size" rather than 8192: the top of the track means "do
 * not resize at all", which is a different statement from any pixel count and
 * the one people reach for most.
 */
const SIZE_MIN = 512;
const SIZE_MAX = 8192;
/**
 * Where the pixel range ends and "full size" begins.
 *
 * Strictly past it, so the largest pixel size on the track is reachable — at
 * exactly this position the slider still means 8192 px, and only beyond it
 * does it mean "do not resize". A control with a value you cannot land on is
 * a control that is lying about its range.
 */
const FULL_FROM = 0.99;

/** The size a slider position means. */
export function sizeFromSlider(position: number): ExportSize {
  if (!Number.isFinite(position) || position > FULL_FROM) return { kind: "full" };
  const at = Math.min(1, Math.max(0, position) / FULL_FROM);
  const edge = SIZE_MIN * (SIZE_MAX / SIZE_MIN) ** at;
  return { kind: "longest", pixels: Math.max(SIZE_MIN, Math.round(edge / 16) * 16) };
}

/** ...and the position that means a size, so the thumb sits where it should. */
export function sliderFromSize(size: ExportSize): number {
  if (size.kind === "full") return 1;
  const clamped = Math.min(SIZE_MAX, Math.max(SIZE_MIN, size.pixels));
  return (Math.log(clamped / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)) * FULL_FROM;
}

export function sizeLabel(size: ExportSize): string {
  return size.kind === "full" ? "full size" : `${size.pixels} px`;
}

/**
 * The sizes worth a mark on the track: what a print wants, what a site wants,
 * what an e-mail wants. Marks, not options — you can stop between them.
 */
export const SIZE_MARKS: readonly { size: ExportSize; note: string }[] = [
  { size: { kind: "longest", pixels: 1024 }, note: "1024 px — e-mail and messages" },
  { size: { kind: "longest", pixels: 2048 }, note: "2048 px — sharing and social" },
  { size: { kind: "longest", pixels: 4096 }, note: "4096 px — prints and large screens" },
  { size: { kind: "full" }, note: "full size — every pixel the crop holds" },
];

/** The lowest quality worth offering. Below this the codec is what you are
 * looking at, and nobody exports a photograph to look at the codec. */
export const QUALITY_MIN = 40;
export const QUALITY_MAX = 100;

export const QUALITY_MARKS: readonly { at: number; note: string }[] = [
  { at: 80, note: "80 — small files, for the web" },
  { at: 90, note: "90 — the usual compromise" },
  { at: 100, note: "100 — as much as JPEG will hold" },
];

/** The quality, with the name of the neighbourhood it is in. The number alone
 * is meaningless to anyone who has not encoded a JPEG by hand. */
export function qualityLabel(quality: number): string {
  if (quality >= 100) return "100 · maximum";
  if (quality >= 88) return `${quality} · high`;
  if (quality >= 72) return `${quality} · web`;
  return `${quality} · small`;
}

export function sameSize(a: ExportSize, b: ExportSize): boolean {
  if (a.kind === "full" || b.kind === "full") return a.kind === b.kind;
  return a.pixels === b.pixels;
}
