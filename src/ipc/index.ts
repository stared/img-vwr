import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "./bindings";
import type {
  DirEntry,
  EmbedModelInfo,
  FileEntry,
  ImageMeta,
  MetaEntry,
  Result,
  SimilarityScore,
} from "./bindings";

export { events };
export type { DirEntry, EmbedModelInfo, FileEntry, ImageMeta, MetaEntry, SimilarityScore };

/** Unwrap a specta Result, throwing on the error branch. */
function unwrap<T>(result: Result<T, string>): T {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

export async function scanFolder(path: string): Promise<FileEntry[]> {
  return unwrap(await commands.scanFolder(path));
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

/**
 * URL the webview can load an image from: remote-source entries already
 * carry https URLs; local paths go through the asset protocol.
 */
export function fileUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return convertFileSrc(path);
}
