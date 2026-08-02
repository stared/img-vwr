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
  Overlay,
  Result,
  SimilarityScore,
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
  Overlay,
  SimilarityScore,
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

/** Pixel statistics (histograms, color triangle) from the cached thumb. */
export async function imageStats(path: string): Promise<ImageStats> {
  return unwrap(await commands.imageStats(path));
}

/** Stored labels for the given paths; unlabeled paths are absent. */
export async function labelsForPaths(paths: string[]): Promise<Record<string, ImageLabels>> {
  const map = unwrap(await commands.labelsForPaths(paths));
  // specta types HashMap values as possibly-undefined; entries never are.
  const out: Record<string, ImageLabels> = {};
  for (const [path, labels] of Object.entries(map)) {
    if (labels !== undefined) out[path] = labels;
  }
  return out;
}

export async function labelsSetStars(path: string, stars: number | null): Promise<ImageLabels> {
  return unwrap(await commands.labelsSetStars(path, stars));
}

export async function labelsToggleTag(path: string, tag: string): Promise<ImageLabels> {
  return unwrap(await commands.labelsToggleTag(path, tag));
}

/* Develop — opening an image for editing, rendering it, and getting pixels
 * back out. Rendering is the interactive path; everything else is rare. */

/** Open an image for editing. Slow on a raw file's first call. */
export async function developState(path: string): Promise<DevelopState> {
  return unwrap(await commands.developState(path));
}

/** Render a preview; the pixels are then loaded from `developFrameUrl`. */
export async function developRender(
  path: string,
  settings: DevelopSettings,
  maxEdge: number,
  overlay: Overlay,
): Promise<DevelopFrame> {
  return unwrap(await commands.developRender(path, settings, maxEdge, overlay));
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
