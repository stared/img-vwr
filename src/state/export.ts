import type { ExifSource, ExportFormat, ExportJob, ExportSize, FileEntry } from "../ipc";
import { isRawEntry, stackKeyOf } from "./stacks";

/** How an export treats a photograph nobody has edited. */
type UneditedPolicy = "camera-jpg" | "render";

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

export interface Candidate {
  entry: FileEntry;
  stack: FileEntry[];
  edited: boolean;
  /** Fronts an HDR set: the file is one exposure of a fused photograph, so only a render exports the truth. */
  hdr: boolean;
}

interface Planned {
  entry: FileEntry;
  job: ExportJob;
  reason: "edited" | "hdr" | "camera-jpg" | "no-jpg" | "always-render";
}

export function jpegOf(candidate: Candidate): FileEntry | null {
  return candidate.stack.find((f) => !isRawEntry(f)) ?? null;
}

/** A render is given the sibling JPEG's EXIF where one exists: the pipeline produces bare pixels. */
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
  if (candidate.hdr) return render("hdr");
  if (options.unedited === "render") return render("always-render");
  // Copying a camera JPEG would ignore the PNG format asked for.
  if (options.format.kind === "png") return render("always-render");
  if (!jpeg) return render("no-jpg");
  return { entry, reason: "camera-jpg", job: { kind: "copy", path: jpeg.path } };
}

export function planAll(candidates: Candidate[], options: ExportOptions): Planned[] {
  return candidates.map((c) => planFor(c, options));
}

function summarise(planned: Planned[]): { copied: number; rendered: number } {
  const copied = planned.filter((p) => p.job.kind === "copy").length;
  return { copied, rendered: planned.length - copied };
}

export function summaryOf(planned: Planned[]): string {
  const { copied, rendered } = summarise(planned);
  const photographs = planned.length === 1 ? "1 photograph" : `${planned.length} photographs`;
  if (planned.length === 0) return "nothing selected";
  if (copied === 0) return `${photographs}, all developed`;
  if (rendered === 0) return `${photographs}, all copied from the camera's JPG`;
  return `${photographs}: ${rendered} developed, ${copied} copied from the camera's JPG`;
}

export function candidatesOf(
  chosen: FileEntry[],
  all: FileEntry[],
  edited: ReadonlySet<string>,
  hdrFaces: ReadonlySet<string> = new Set(),
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
      // Edited when any file of the stack is: the edit was made on whichever one was on screen.
      edited: stack.some((f) => edited.has(f.path)),
      hdr: hdrFaces.has(entry.path),
    };
  });
}

/* Log-scale slider, sizes rounded to multiples of 16; the track ends at the selection's largest edge — an export never upscales. */
const SIZE_FLOOR = 512;
/** Where the track ends when nothing is known about the photographs yet. */
const SIZE_CEILING = 8192;

/** The pixel range this selection's slider actually spans. */
interface SizeScale {
  min: number;
  max: number;
}

/** Strictly past this the track means "do not resize"; at exactly it, the largest pixel size is still reachable. */
const FULL_FROM = 0.97;

export function sizeScaleFor(longestEdge: number | null): SizeScale {
  const max = longestEdge === null ? SIZE_CEILING : longestEdge;
  return { min: SIZE_FLOOR, max: Math.max(SIZE_FLOOR * 2, Math.round(max)) };
}

export function sizeFromSlider(position: number, scale: SizeScale): ExportSize {
  if (!Number.isFinite(position) || position > FULL_FROM) return { kind: "full" };
  const at = Math.min(1, Math.max(0, position) / FULL_FROM);
  const edge = scale.min * (scale.max / scale.min) ** at;
  return {
    kind: "longest",
    pixels: Math.min(scale.max, Math.max(scale.min, Math.round(edge / 16) * 16)),
  };
}

export function sliderFromSize(size: ExportSize, scale: SizeScale): number {
  if (size.kind === "full") return 1;
  const clamped = Math.min(scale.max, Math.max(scale.min, size.pixels));
  return (Math.log(clamped / scale.min) / Math.log(scale.max / scale.min)) * FULL_FROM;
}

export function sizeLabel(size: ExportSize, native: NativeSize): string {
  if (size.kind === "longest") return `${size.pixels} px`;
  if (native.longest === null) return "full size";
  return native.mixed ? `full size · up to ${native.longest} px` : `full size · ${native.longest} px`;
}

/** The longest edge in the selection, and whether they all agree on it. */
interface NativeSize {
  longest: number | null;
  mixed: boolean;
}

export const UNKNOWN_SIZE: NativeSize = { longest: null, mixed: false };

/** Entries whose metadata has not arrived are simply not counted — the label must not wait for the slowest file. */
export function nativeSizeOf(
  entries: readonly { path: string }[],
  dimensions: (path: string) => { width: number; height: number } | null,
): NativeSize {
  const edges: number[] = [];
  for (const entry of entries) {
    const dims = dimensions(entry.path);
    if (dims) edges.push(Math.max(dims.width, dims.height));
  }
  if (edges.length === 0) return UNKNOWN_SIZE;
  const longest = Math.max(...edges);
  return { longest, mixed: edges.some((e) => e !== longest) };
}

export function sizeMarksFor(scale: SizeScale): { size: ExportSize; note: string }[] {
  const marks = [
    { pixels: 1024, note: "1024 px — e-mail and messages" },
    { pixels: 2048, note: "2048 px — sharing and social" },
    { pixels: 4096, note: "4096 px — prints and large screens" },
  ].filter((mark) => mark.pixels < scale.max);
  return [
    ...marks.map((mark) => ({
      size: { kind: "longest", pixels: mark.pixels } as ExportSize,
      note: mark.note,
    })),
    { size: { kind: "full" } as ExportSize, note: "full size — every pixel the crop holds" },
  ];
}

/** Below this the codec is what you are looking at. */
export const QUALITY_MIN = 40;
export const QUALITY_MAX = 100;

export const QUALITY_MARKS: readonly { at: number; note: string }[] = [
  { at: 80, note: "80 — small files, for the web" },
  { at: 90, note: "90 — the usual compromise" },
  { at: 100, note: "100 — as much as JPEG will hold" },
];

export function qualityLabel(quality: number): string {
  if (quality >= 100) return "100 · maximum";
  if (quality >= 88) return `${quality} · high`;
  if (quality >= 72) return `${quality} · web`;
  return `${quality} · small`;
}

