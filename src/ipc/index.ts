import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "./bindings";
import type {
  DevelopFrame,
  DevelopParams,
  DevelopSettings,
  DevelopState,
  DirEntry,
  EmbedModelInfo,
  FileEntry,
  Histogram,
  ImageLabels,
  ImageMeta,
  ImageStats,
  MetaEntry,
  PersonCluster,
  Crop,
  Overlay,
  Preset,
  RegionArg,
  Result,
  SimilarityScore,
  TrashOutcome,
  WhiteBalance,
} from "./bindings";

export { events };
export type {
  DevelopFrame,
  DevelopParams,
  DevelopSettings,
  DevelopState,
  DirEntry,
  EmbedModelInfo,
  FileEntry,
  Histogram,
  ImageLabels,
  ImageMeta,
  ImageStats,
  MetaEntry,
  PersonCluster,
  Crop,
  Overlay,
  Preset,
  RegionArg,
  SimilarityScore,
  TrashOutcome,
  WhiteBalance,
};

/** Unwrap a specta Result, throwing on the error branch. */
function unwrap<T>(result: Result<T, string>): T {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

/** Start a streamed scan; entries arrive as epoch-guarded `scanBatch` events. */
export async function scanFolder(path: string, recursive: boolean, epoch: number): Promise<void> {
  unwrap(await commands.scanFolder(path, recursive, epoch));
}

export async function listSubdirs(path: string): Promise<DirEntry[]> {
  return unwrap(await commands.listSubdirs(path));
}

/**
 * Move files to the platform Trash, reporting per file.
 *
 * The caller has already asked the user — this only carries the answer. What
 * comes back says which paths actually went; only those may be dropped from
 * the collection.
 */
export async function deleteFiles(paths: string[]): Promise<TrashOutcome> {
  return unwrap(await commands.deleteFiles(paths));
}

/** Put files on the system clipboard as file references — what a paste in
 * the Finder or a chat receives as the files themselves. */
export async function copyFiles(paths: string[]): Promise<number> {
  return unwrap(await commands.copyFiles(paths));
}

export async function newEpoch(): Promise<number> {
  return commands.newEpoch();
}

export async function requestThumbnails(paths: string[], epoch: number): Promise<void> {
  return commands.requestThumbnails(paths, epoch);
}

export async function requestDirCounts(paths: string[]): Promise<void> {
  return commands.requestDirCounts(paths);
}

export async function requestMeta(paths: string[], epoch: number): Promise<void> {
  return commands.requestMeta(paths, epoch);
}

export async function embeddingModels(): Promise<EmbedModelInfo[]> {
  return commands.embeddingModels();
}

export async function embeddingSelect(modelId: string): Promise<void> {
  return commands.embeddingSelect(modelId);
}

export async function embeddingIndex(paths: string[], epoch: number): Promise<void> {
  return commands.embeddingIndex(paths, epoch);
}

export async function embeddingRankImage(
  anchor: string,
  paths: string[],
): Promise<SimilarityScore[]> {
  return unwrap(await commands.embeddingRankImage(anchor, paths));
}

export async function embeddingRankText(
  query: string,
  paths: string[],
): Promise<SimilarityScore[]> {
  return unwrap(await commands.embeddingRankText(query, paths));
}

/** Similarity of each path to the few before it (scores[i][d-1] describes
 * paths[i] vs paths[i-d]), from vectors already indexed; null where an
 * image has no vector yet. Never computes. */
export async function embeddingBandedScores(
  paths: string[],
  band: number,
): Promise<(number | null)[][]> {
  return unwrap(await commands.embeddingBandedScores(paths, band));
}

/** Detect faces over the collection in the background; progress arrives as
 * `facesProgress` events, per-photo results are cached. */
export async function facesIndex(paths: string[], epoch: number): Promise<void> {
  return commands.facesIndex(paths, epoch);
}

/** Cluster detected faces into people; identity propagates onto faceless
 * photos near-identical to a member. Needs the embedding model loaded. */
export async function facesPeople(
  paths: string[],
  threshold: number,
  propagate: number,
): Promise<PersonCluster[]> {
  return unwrap(await commands.facesPeople(paths, threshold, propagate));
}

/** Pixel statistics (histograms, color triangle) from the cached thumb. */
export async function imageStats(path: string): Promise<ImageStats> {
  return unwrap(await commands.imageStats(path));
}

/** Stored labels for the given paths; unlabeled paths are absent. */
export async function labelsForPaths(paths: string[]): Promise<Record<string, ImageLabels>> {
  return defined(unwrap(await commands.labelsForPaths(paths)));
}

/* Writes take a list because rating and tagging apply to the selection, and
 * answer for every path given — including ones left with no labels at all,
 * which is how the caller tells "cleared" from "unchanged". */

export async function labelsSetStars(
  paths: string[],
  stars: number | null,
): Promise<Record<string, ImageLabels>> {
  return defined(unwrap(await commands.labelsSetStars(paths, stars)));
}

export async function labelsToggleTag(
  paths: string[],
  tag: string,
): Promise<Record<string, ImageLabels>> {
  return defined(unwrap(await commands.labelsToggleTag(paths, tag)));
}

/** specta types HashMap values as possibly-undefined; entries never are. */
function defined(map: Partial<Record<string, ImageLabels>>): Record<string, ImageLabels> {
  const out: Record<string, ImageLabels> = {};
  for (const [path, labels] of Object.entries(map)) {
    if (labels !== undefined) out[path] = labels;
  }
  return out;
}

/* Develop — opening an image for editing, rendering it, and getting pixels
 * back out. Rendering is the interactive path; everything else is rare. */

/** Open an image for editing. Slow on a raw file's first call. */
export async function developState(path: string): Promise<DevelopState> {
  return unwrap(await commands.developState(path));
}

/** The named starting points an edit can be set to. Fixed for a session. */
export async function developPresets(): Promise<Preset[]> {
  return unwrap(await commands.developPresets());
}

/** The exposure this image wants, in stops, from the light it recorded. */
export async function developAutoExposure(
  path: string,
  settings: DevelopSettings,
): Promise<number> {
  return unwrap(await commands.developAutoExposure(path, settings));
}

/** Where this frame is sharpest, in the cropped image's coordinates. */
export async function developFocusPoint(
  path: string,
  settings: DevelopSettings,
): Promise<[number, number]> {
  return unwrap(await commands.developFocusPoint(path, settings));
}

/** Render a preview; the pixels are then loaded from `developFrameUrl`. */
export async function developRender(
  path: string,
  settings: DevelopSettings,
  maxEdge: number,
  overlay: Overlay,
  region: RegionArg,
): Promise<DevelopFrame> {
  return unwrap(await commands.developRender(path, settings, maxEdge, overlay, region));
}

/** The whole frame. */
export const FULL_REGION: RegionArg = { x: 0, y: 0, width: 1, height: 1 };

/** White balance that renders the point at normalised (x, y) neutral. */
export async function developPickWhiteBalance(
  path: string,
  x: number,
  y: number,
  settings: DevelopSettings,
): Promise<WhiteBalance> {
  return unwrap(await commands.developPickWhiteBalance(path, x, y, settings));
}

export async function developSave(path: string, settings: DevelopSettings): Promise<void> {
  unwrap(await commands.developSave(path, settings));
}

/** Discard an image's edit; returns its freshly neutral state. */
export async function developReset(path: string): Promise<DevelopState> {
  return unwrap(await commands.developReset(path));
}

export async function developEditedPaths(paths: string[]): Promise<string[]> {
  return unwrap(await commands.developEditedPaths(paths));
}

export async function developExport(
  path: string,
  settings: DevelopSettings,
  destination: string,
): Promise<void> {
  unwrap(await commands.developExport(path, settings, destination));
}

/**
 * URL for a rendered frame. The token changes on every render, which is what
 * stops the webview's image cache from serving the previous edit.
 */
export function developFrameUrl(token: number): string {
  return `develop://localhost/frame/${token}`;
}

/**
 * URL the webview can load an image from: remote-source entries already
 * carry https URLs; local paths go through the asset protocol.
 */
export function fileUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return convertFileSrc(path);
}
