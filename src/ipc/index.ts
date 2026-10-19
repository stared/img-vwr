import { convertFileSrc } from "@tauri-apps/api/core";

import { commands, events } from "./bindings";
import type { Crop, ImageLabels, RegionArg, Result } from "./bindings";

export { events };
export type * from "./bindings";

function unwrap<T>(result: Result<T, string>): T {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

type Unwrapped<T> = [T] extends [Result<infer D, string>] ? D : T;

/** The generated commands with their `Result` errors thrown instead of returned; docs live on the Rust side. */
export type Api = {
  [K in keyof typeof commands]: (
    ...args: Parameters<(typeof commands)[K]>
  ) => Promise<Unwrapped<Awaited<ReturnType<(typeof commands)[K]>>>>;
};

function isResult(value: unknown): value is Result<unknown, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "ok" || value.status === "error")
  );
}

/** Commands that cannot fail return plain values (numbers, arrays, null), which pass through untouched. */
export const api = new Proxy(commands, {
  get: (target, name: string) => {
    const command = (target as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
    if (command === undefined) throw new Error(`no such command: ${name}`);
    return async (...args: unknown[]) => {
      const result = await command(...args);
      return isResult(result) ? unwrap(result) : result;
    };
  },
}) as unknown as Api;




















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






export const FULL_REGION: RegionArg = { x: 0, y: 0, width: 1, height: 1 };





export async function developCrops(paths: string[]): Promise<Record<string, Crop>> {
  return defined(unwrap(await commands.developCrops(paths)));
}


/** The per-render token stops the webview's image cache from serving the previous edit. */
export function developFrameUrl(token: number): string {
  return `develop://localhost/frame/${token}`;
}

/** Sources hand out web URLs; everything else is a path on this machine. */
export function isLocal(path: string): boolean {
  return !path.startsWith("http://") && !path.startsWith("https://");
}

export function fileUrl(path: string): string {
  return isLocal(path) ? convertFileSrc(path) : path;
}
