import type { FileEntry, ImageMeta, WhiteBalance } from "../ipc";

/**
 * Fact registry — the things that can be *said* about one photograph.
 *
 * Same reasoning as the sort and filter registries: which facts an overlay
 * shows is precisely the kind of thing a plugin should be able to extend, and
 * a hardcoded list would have to be edited every time a format learns to
 * report something new. A fact provider knows how to get its value and how to
 * word it; nothing that displays facts knows what facts exist.
 *
 * Every field is required, as everywhere else in the registries: a provider
 * that could omit `value` would be a provider that sometimes means nothing,
 * and callers would have to guess what that meant.
 */

export interface FactContext {
  entry: FileEntry;
  /** Undefined until the background metadata read reaches this file. */
  meta: ImageMeta | undefined;
  /**
   * The white balance the camera chose for this frame, when a develop
   * session knows it; null for finished files and before the session
   * loads. Auto WB re-solves every shot, so this is per-frame data the
   * way shutter speed is, not a setting.
   */
  asShot: WhiteBalance | null;
}

export interface ImageFact {
  id: string;
  /** How the fact names itself when it needs a label. */
  label: string;
  /**
   * The fact, worded for a person, or null when this photograph does not
   * carry it. Null is the honest answer for a JPEG with no EXIF; it is not
   * an error and not a blank string.
   */
  value: (ctx: FactContext) => string | null;
  /**
   * Facts that belong on one line together — filename alone, then the body,
   * then the exposure, then what the camera's processing decided. Ordering
   * within a group follows registration order.
   */
  group: "identity" | "camera" | "exposure" | "grade" | "file";
}

const registry = new Map<string, ImageFact>();

export function registerFact(fact: ImageFact): void {
  if (registry.has(fact.id)) {
    throw new Error(`fact already registered: ${fact.id}`);
  }
  registry.set(fact.id, fact);
}

export function allFacts(): ImageFact[] {
  return [...registry.values()];
}

export function getFact(id: string): ImageFact | undefined {
  return registry.get(id);
}

/** Test helper, matching the other registries. */
export function clearFactsForTest(): void {
  registry.clear();
}

/**
 * The facts this photograph actually carries, grouped for display.
 *
 * Groups that came out empty are dropped rather than rendered as a blank
 * line: an overlay over a photograph should occupy exactly as much of it as
 * it has something to say.
 */
export function factLines(
  ids: readonly string[],
  ctx: FactContext,
): { group: ImageFact["group"]; parts: string[] }[] {
  const order: ImageFact["group"][] = ["identity", "camera", "exposure", "grade", "file"];
  return order
    .map((group) => ({
      group,
      parts: ids
        .map((id) => registry.get(id))
        .filter((fact): fact is ImageFact => fact?.group === group)
        .map((fact) => fact.value(ctx))
        .filter((value): value is string => value !== null && value !== ""),
    }))
    .filter((line) => line.parts.length > 0);
}
