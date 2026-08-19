import type { FileEntry, ImageMeta, WhiteBalance } from "../ipc";

export interface FactContext {
  entry: FileEntry;
  /** Undefined until the background metadata read reaches this file. */
  meta: ImageMeta | undefined;
  /** The camera's per-frame WB; null for finished files and before the develop session loads. */
  asShot: WhiteBalance | null;
}

export interface ImageFact {
  id: string;
  label: string;
  /** Worded for a person; null (never a blank string) when the photograph does not carry the fact. */
  value: (ctx: FactContext) => string | null;
  /** Facts in one group share a display line, in registration order. */
  group: "identity" | "camera" | "exposure" | "grade" | "file";
}

const registry = new Map<string, ImageFact>();

export function registerFact(fact: ImageFact): void {
  if (registry.has(fact.id)) {
    throw new Error(`fact already registered: ${fact.id}`);
  }
  registry.set(fact.id, fact);
}

export function clearFactsForTest(): void {
  registry.clear();
}

/** Groups that came out empty are dropped, not rendered as blank lines. */
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
