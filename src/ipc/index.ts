import { commands } from "./bindings";
import type { DirEntry, FileEntry, Result } from "./bindings";

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
