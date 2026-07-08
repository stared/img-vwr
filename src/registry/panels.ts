import type { ComponentType } from "react";

/**
 * Sidebar panel registry — v1 registers only the folder tree, but the
 * sidebar renders whatever is here, which is the future plugin UI seam.
 */

export type PanelSide = "left" | "right";

export interface Panel {
  id: string;
  title: string;
  component: ComponentType;
  /** Which shell edge hosts the panel; defaults to the left sidebar. */
  side?: PanelSide;
  /** Take the remaining sidebar height and scroll internally. */
  fill?: boolean;
}

const registry = new Map<string, Panel>();

export function registerPanel(panel: Panel): void {
  if (registry.has(panel.id)) {
    throw new Error(`panel already registered: ${panel.id}`);
  }
  registry.set(panel.id, panel);
}

export function allPanels(side: PanelSide = "left"): Panel[] {
  return [...registry.values()].filter((p) => (p.side ?? "left") === side);
}
