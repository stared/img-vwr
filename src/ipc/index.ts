import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "./bindings";
import type { DirEntry, FileEntry, Result } from "./bindings";

export { events };
export type { DirEntry, FileEntry };

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

/** asset:// URL the webview can load a local file from. */
export function fileUrl(path: string): string {
  return convertFileSrc(path);
}
