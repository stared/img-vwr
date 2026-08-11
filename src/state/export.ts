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

/** The sizes worth offering, longest edge in pixels. */
export const SIZE_CHOICES: readonly { size: ExportSize; label: string; note: string }[] = [
  { size: { kind: "full" }, label: "full size", note: "every pixel the crop holds" },
  { size: { kind: "longest", pixels: 4096 }, label: "4096 px", note: "prints and large screens" },
  { size: { kind: "longest", pixels: 2048 }, label: "2048 px", note: "sharing and social" },
  { size: { kind: "longest", pixels: 1024 }, label: "1024 px", note: "e-mail and messages" },
];

export const QUALITY_CHOICES: readonly { quality: number; label: string }[] = [
  { quality: 100, label: "maximum" },
  { quality: 90, label: "high" },
  { quality: 80, label: "web" },
];

export function sameSize(a: ExportSize, b: ExportSize): boolean {
  if (a.kind === "full" || b.kind === "full") return a.kind === b.kind;
  return a.pixels === b.pixels;
}
