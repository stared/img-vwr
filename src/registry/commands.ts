import type { useAppStore } from "../state/store";

export interface CommandContext {
  store: typeof useAppStore;
}

export type CommandMenu = "image";

/** Separator groups of a context menu, in render order; destructive last. */
export const MENU_SECTIONS = ["open", "labels", "develop", "transfer", "danger"] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];

export interface MenuPlacement {
  menu: CommandMenu;
  section: MenuSection;
  /** Placements sharing a submenu title collapse under one row; null = top level. */
  submenu: string | null;
  /** Row text in that menu; the palette always shows the full `title` instead. */
  label: string;
}

export interface Command {
  id: string;
  title: string;
  keywords?: string[];
  /** If set, the palette collects a text argument before running. */
  input?: { placeholder: string };
  /** Every command states its placements; [] = palette only. */
  menus: MenuPlacement[];
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

export interface MenuEntry {
  command: Command;
  placement: MenuPlacement;
  /** False renders the row grayed rather than hidden. */
  enabled: boolean;
}

/** Disabled entries included; MENU_SECTIONS order, registration order within a section. */
export function menuEntries(menu: CommandMenu, ctx: CommandContext): MenuEntry[] {
  const rank = (e: MenuEntry) => MENU_SECTIONS.indexOf(e.placement.section);
  return allCommands()
    .flatMap((command) => {
      const placement = command.menus.find((p) => p.menu === menu);
      if (!placement) return [];
      return [{ command, placement, enabled: !command.when || command.when(ctx) }];
    })
    .sort((a, b) => rank(a) - rank(b));
}

export function executeCommand(id: string, ctx: CommandContext, arg?: string): boolean {
  const command = registry.get(id);
  if (!command || (command.when && !command.when(ctx))) {
    return false;
  }
  void command.run(ctx, arg);
  return true;
}

export function clearCommandsForTest(): void {
  registry.clear();
}

/** Case-insensitive subsequence match; higher = better, null = no match. */
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
