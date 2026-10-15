import type { ComponentType } from "react";

export interface GalleryView {
  id: string;
  label: string;
  hint: string;
  component: ComponentType;
  keywords: string[];
  /** The view exposes image magnification in the workspace bar. */
  zoomable: boolean;
  /** One photograph on screen at a time, so a raw+JPEG pair collapses to one; views listing every file say false. */
  stacks: boolean;
  /** The view's own settings, under its row in the view menu; null when it has none. */
  Knobs: ComponentType | null;
}

const registry = new Map<string, GalleryView>();

export function registerView(view: GalleryView): void {
  if (registry.has(view.id)) throw new Error(`view already registered: ${view.id}`);
  registry.set(view.id, view);
}

export function allViews(): GalleryView[] {
  return [...registry.values()];
}

export function getView(id: string): GalleryView | undefined {
  return registry.get(id);
}
