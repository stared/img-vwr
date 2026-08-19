import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "./bindings";
import type {
  DevelopFrame,
  DevelopParams,
  DevelopSettings,
  DevelopState,
  DirEntry,
  EmbedModelInfo,
  ExifSource,
  Exported,
  ExportFormat,
  ExportJob,
  ExportPlan,
  ExportSize,
  FileEntry,
  FusionRecipe,
  HdrMethod,
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
  ExifSource,
  Exported,
  ExportFormat,
  ExportJob,
  ExportPlan,
  ExportSize,
  FileEntry,
  FusionRecipe,
  HdrMethod,
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

/** Move files to the platform Trash; only paths reported gone may be dropped from the collection. */
export async function deleteFiles(paths: string[]): Promise<TrashOutcome> {
  return unwrap(await commands.deleteFiles(paths));
}

/** Puts file references (not pixel data) on the system clipboard. */
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

/** scores[i][d-1] is paths[i] vs paths[i-d]; null where unindexed — never computes vectors. */
export async function embeddingBandedScores(
  paths: string[],
  band: number,
): Promise<(number | null)[][]> {
  return unwrap(await commands.embeddingBandedScores(paths, band));
}

/** Returns immediately; progress arrives as `facesProgress` events. */
export async function facesIndex(paths: string[], epoch: number): Promise<void> {
  return commands.facesIndex(paths, epoch);
}

/** Needs the embedding model loaded; identity also propagates onto faceless near-identical photos. */
export async function facesPeople(
  paths: string[],
  threshold: number,
  merge: number,
  propagate: number,
): Promise<PersonCluster[]> {
  return unwrap(await commands.facesPeople(paths, threshold, merge, propagate));
}

/** An empty name un-names; clusters named alike merge on the next clustering. */
export async function facesRename(
  clusterId: string,
  name: string,
  merge: number,
): Promise<void> {
  unwrap(await commands.facesRename(clusterId, name, merge));
}

/** Every name ever given, not only names in the current clustering. */
export async function facesNames(): Promise<string[]> {
  return unwrap(await commands.facesNames());
}

/** Computed from the cached thumbnail, not the full image. */
export async function imageStats(path: string): Promise<ImageStats> {
  return unwrap(await commands.imageStats(path));
}

/** Unlabeled paths are absent from the result. */
export async function labelsForPaths(paths: string[]): Promise<Record<string, ImageLabels>> {
  return defined(unwrap(await commands.labelsForPaths(paths)));
}

/* Label writes answer for every path given, empty labels included — that is how "cleared" differs from "unchanged". */

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
function defined<T>(map: Partial<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [path, value] of Object.entries(map)) {
    if (value !== undefined) out[path] = value;
  }
  return out;
}

/** Slow on a raw file's first call. */
export async function developState(path: string): Promise<DevelopState> {
  return unwrap(await commands.developState(path));
}

/** Fixed for a session. */
export async function developPresets(): Promise<Preset[]> {
  return unwrap(await commands.developPresets());
}

/** Suggested exposure, in stops. */
export async function developAutoExposure(
  path: string,
  settings: DevelopSettings,
): Promise<number> {
  return unwrap(await commands.developAutoExposure(path, settings));
}

/** Sharpest point, in the cropped image's coordinates. */
export async function developFocusPoint(
  path: string,
  settings: DevelopSettings,
): Promise<[number, number]> {
  return unwrap(await commands.developFocusPoint(path, settings));
}

/** Pixels are not returned; load them from `developFrameUrl`. */
export async function developRender(
  path: string,
  settings: DevelopSettings,
  maxEdge: number,
  overlay: Overlay,
  region: RegionArg,
): Promise<DevelopFrame> {
  return unwrap(await commands.developRender(path, settings, maxEdge, overlay, region));
}

export const FULL_REGION: RegionArg = { x: 0, y: 0, width: 1, height: 1 };

/** (x, y) are normalised; the returned WB renders that point neutral. */
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

export async function developReset(path: string): Promise<DevelopState> {
  return unwrap(await commands.developReset(path));
}

export async function developEditedPaths(paths: string[]): Promise<string[]> {
  return unwrap(await commands.developEditedPaths(paths));
}

export async function developCrops(paths: string[]): Promise<Record<string, Crop>> {
  return defined(unwrap(await commands.developCrops(paths)));
}

/** Exports one photograph; the caller drives the batch. */
export async function developExport(job: ExportJob, plan: ExportPlan): Promise<Exported> {
  return unwrap(await commands.developExport(job, plan));
}

/** Replaces the whole map: pass every fusion in the folder, keyed by the face frame's path. */
export async function developSetFusions(
  fusions: Record<string, FusionRecipe>,
): Promise<void> {
  return commands.developSetFusions(fusions);
}

/** The per-render token stops the webview's image cache from serving the previous edit. */
export function developFrameUrl(token: number): string {
  return `develop://localhost/frame/${token}`;
}

export function fileUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return convertFileSrc(path);
}
