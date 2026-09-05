import type { ComponentType } from "react";

import type { GalleryLayout } from "../state/store";

export interface GalleryView {
  id: GalleryLayout;
  label: string;
  hint: string;
  component: ComponentType;
  keywords: string[];
  /** The view exposes image magnification in the workspace bar. */
  zoomable: boolean;
}

const registry = new Map<GalleryLayout, GalleryView>();

export function registerView(view: GalleryView): void {
  if (registry.has(view.id)) throw new Error(`view already registered: ${view.id}`);
  registry.set(view.id, view);
}

export function allViews(): GalleryView[] {
  return [...registry.values()];
}

export function getView(id: GalleryLayout): GalleryView | undefined {
  return registry.get(id);
}
