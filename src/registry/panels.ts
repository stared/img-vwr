import type { ComponentType, ReactNode } from "react";

export type PanelSide = "left" | "right";

export interface Panel {
  id: string;
  title: string;
  component: ComponentType;
  /** Activity-bar glyph for left panels (chosen one at a time); null shows the title's first letter. */
  icon: ReactNode | null;
  /** Which shell edge hosts the panel. */
  side: PanelSide;
  /** Default position on its side, ascending; the user's own arrangement overrides it. */
  order: number;
  /** Take the remaining sidebar height and scroll internally. */
  fill: boolean;
  /** Renders only while true. */
  when: () => boolean;
}

const registry = new Map<string, Panel>();

export function registerPanel(panel: Panel): void {
  if (registry.has(panel.id)) {
    throw new Error(`panel already registered: ${panel.id}`);
  }
  registry.set(panel.id, panel);
}

export function allPanels(side: PanelSide): Panel[] {
  return [...registry.values()].filter((p) => p.side === side).sort((a, b) => a.order - b.order);
}

export const always = (): boolean => true;
