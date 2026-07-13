import type { useAppStore } from "../state/store";

/**
 * Command registry — the UI-side extension seam. The palette, keybindings
 * and menus all resolve through here; a future plugin API registers into
 * the same table.
 */

export interface CommandContext {
  store: typeof useAppStore;
}

/** Context menus a command can surface in, besides the palette. */
export type CommandMenu = "image";

export interface Command {
  id: string;
  title: string;
  /** Extra palette search terms. */
  keywords?: string[];
  /** If set, the palette collects a text argument before running. */
  input?: { placeholder: string };
  /**
   * Menus this command appears in — every command states its placements
   * ([] = palette only). Right-clicking an image lists the "image" ones.
   */
  menus: CommandMenu[];
  /** Shown in the palette next to the title (derived from keybindings). */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, arg?: string) => void | Promise<void>;
}

const registry = new Map<string, Command>();

export function registerCommand(command: Command): void {
  if (registry.has(command.id)) {
    throw new Error(`command already registered: ${command.id}`);
  }
  registry.set(command.id, command);
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

/** Applicable commands for a context menu, in registration order. */
export function menuCommands(menu: CommandMenu, ctx: CommandContext): Command[] {
  return allCommands().filter(
    (c) => c.menus.includes(menu) && (!c.when || c.when(ctx)),
  );
}

/** Runs the command if it exists and its `when` guard passes. */
export function executeCommand(id: string, ctx: CommandContext, arg?: string): boolean {
  const command = registry.get(id);
  if (!command || (command.when && !command.when(ctx))) {
    return false;
  }
  void command.run(ctx, arg);
  return true;
}

/** Test-only: reset global registry state between test cases. */
export function clearCommandsForTest(): void {
  registry.clear();
}

/**
 * Case-insensitive subsequence match of `query` against a command's
 * searchable text; higher score = better (consecutive and word-start
 * matches score extra). Null = no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let ti = 0;
  let lastMatch = -1;
  for (const ch of q) {
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;
    score += 1;
    if (found === lastMatch + 1) score += 2; // consecutive run
    if (found === 0 || t[found - 1] === " " || t[found - 1] === "-") score += 3; // word start
    lastMatch = found;
    ti = found + 1;
  }
  return score;
}

export function searchCommands(query: string, ctx: CommandContext): Command[] {
  return allCommands()
    .filter((c) => !c.when || c.when(ctx))
    .map((c) => ({
      command: c,
      score: fuzzyScore(query, [c.title, c.id, ...(c.keywords ?? [])].join(" ")),
    }))
    .filter((r): r is { command: Command; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.command);
}
