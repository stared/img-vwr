import type { ComponentType } from "react";

/**
 * Sidebar panel registry — v1 registers only the folder tree, but the
 * sidebar renders whatever is here, which is the future plugin UI seam.
 */

export interface Panel {
  id: string;
  title: string;
  component: ComponentType;
}

const registry = new Map<string, Panel>();

export function registerPanel(panel: Panel): void {
  if (registry.has(panel.id)) {
    throw new Error(`panel already registered: ${panel.id}`);
  }
  registry.set(panel.id, panel);
}

export function allPanels(): Panel[] {
  return [...registry.values()];
}
