import { open } from "@tauri-apps/plugin-dialog";

import { registerCommand, type CommandContext } from "../registry/commands";
import { allSorts } from "../registry/sorts";
import { FORMAT_GROUPS } from "../state/query";
import type { GalleryLayout } from "../state/store";

const ZOOM_STEP = 1.25;

function inViewer(ctx: CommandContext): boolean {
  return ctx.store.getState().viewMode === "viewer";
}

function hasImages(ctx: CommandContext): boolean {
  return ctx.store.getState().entries.length > 0;
}

/** Registered once at startup; a future plugin manifest merges into the same registry. */
export function registerBuiltinCommands(): void {
  registerCommand({
    id: "folder.open",
    title: "Open Folder…",
    keywords: ["directory", "browse"],
    menus: [],
    run: async ({ store }) => {
      const selected = await open({ directory: true, title: "Open Folder" });
      if (typeof selected === "string") {
        await store.getState().openFolder(selected, false);
      }
    },
  });

  registerCommand({
    id: "palette.open",
    title: "Command Palette",
    keywords: ["commands", "search"],
    menus: [],
    run: ({ store }) => store.getState().setPaletteOpen(true),
  });

  registerCommand({
    id: "sidebar.toggle",
    title: "Toggle Sidebar",
    menus: [],
    run: ({ store }) => store.getState().toggleSidebar(),
  });

  registerCommand({
    id: "stats.toggle",
    title: "Toggle Statistics",
    keywords: ["histogram", "exif", "panel"],
    menus: [],
    run: ({ store }) => store.getState().toggleStats(),
  });

  // One command per way the query renders — Lightroom's grammar: G means
  // the grid wherever you are, D the darkroom. From the viewer the key
  // first steps back to the gallery, so the keys never feel modal.
  const views: { layout: GalleryLayout; title: string; keywords: string[] }[] = [
    { layout: "grid", title: "Grid View", keywords: ["thumbnails", "cells"] },
    { layout: "mosaic", title: "Mosaic View", keywords: ["packed", "wall", "justified"] },
    { layout: "scenes", title: "Scenes View", keywords: ["moments", "groups", "series", "burst"] },
    { layout: "timeline", title: "Timeline View", keywords: ["date", "taken", "time", "chronological"] },
    { layout: "map", title: "Map View", keywords: ["geo", "gps", "location"] },
    { layout: "darkroom", title: "Darkroom View", keywords: ["develop", "edit", "filmstrip", "lightroom"] },
  ];
  for (const view of views) {
    registerCommand({
      id: `view.${view.layout}`,
      title: view.title,
      keywords: view.keywords,
      when: hasImages,
      menus: [],
      run: ({ store }) => {
        const state = store.getState();
        if (state.viewMode === "viewer") state.closeViewer();
        store.getState().setGalleryLayout(view.layout);
      },
    });
  }

  registerCommand({
    id: "viewer.open",
    title: "Open Image",
    keywords: ["view", "show"],
    menus: [{ menu: "image", submenu: null, label: "Open Image" }],
    when: (ctx) => ctx.store.getState().selectedIndex !== null && !inViewer(ctx),
    run: ({ store }) => {
      const { selectedIndex, openViewer } = store.getState();
      if (selectedIndex !== null) openViewer(selectedIndex);
    },
  });

  registerCommand({
    id: "selection.all",
    title: "Select All",
    keywords: ["every", "everything", "whole folder", "multiple"],
    menus: [],
    // Everything the query is showing — which is the point of it being the
    // visible list: filter first, then select what the filter left.
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    run: ({ store }) => store.getState().selectAll(),
  });

  registerCommand({
    id: "selection.clear",
    title: "Clear Selection",
    keywords: ["deselect", "escape", "none"],
    menus: [],
    when: (ctx) => ctx.store.getState().selectedIndex !== null,
    run: ({ store }) => store.getState().select(null),
  });

  registerCommand({
    id: "viewer.close",
    title: "Back to Gallery",
    keywords: ["escape", "grid"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().closeViewer(),
  });

  registerCommand({
    id: "image.next",
    title: "Next Image",
    when: hasImages,
    menus: [],
    run: ({ store }) => store.getState().navigate(1),
  });

  registerCommand({
    id: "image.prev",
    title: "Previous Image",
    when: hasImages,
    menus: [],
    run: ({ store }) => store.getState().navigate(-1),
  });

  // A visual row, not a fixed count: the mounted view registers how far
  // "down" is (the grid its columns, the mosaic its bands). Where no view
  // has, the chord falls through to plain next/previous.
  registerCommand({
    id: "image.below",
    title: "Image Below",
    keywords: ["down", "row"],
    when: (ctx) => hasImages(ctx) && ctx.store.getState().rowNavigator !== null,
    menus: [],
    run: ({ store }) => store.getState().rowNavigator?.(1),
  });

  registerCommand({
    id: "image.above",
    title: "Image Above",
    keywords: ["up", "row"],
    when: (ctx) => hasImages(ctx) && ctx.store.getState().rowNavigator !== null,
    menus: [],
    run: ({ store }) => store.getState().rowNavigator?.(-1),
  });

  registerCommand({
    id: "viewer.zoomIn",
    title: "Zoom In",
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoom(ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomOut",
    title: "Zoom Out",
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoom(1 / ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomFit",
    title: "Zoom to Fit",
    keywords: ["reset"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoomFit(),
  });

  registerCommand({
    id: "viewer.zoomActual",
    title: "Zoom to 100%",
    keywords: ["actual size", "pixel"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoomActual(),
  });

  registerCommand({
    id: "filter.find",
    title: "Find by Name…",
    keywords: ["search", "filter"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    menus: [],
    run: ({ store }) => store.getState().setFindOpen(true),
  });

  for (const group of FORMAT_GROUPS) {
    registerCommand({
      id: `filter.format.${group.id}`,
      title: `Filter: ${group.label}`,
      keywords: ["type", "format", "toggle"],
      when: (ctx) => hasImages(ctx) && !inViewer(ctx),
      menus: [],
    run: ({ store }) => store.getState().toggleFormatFilter(group.id),
    });
  }

  registerCommand({
    id: "filter.clear",
    title: "Clear Filters",
    when: ({ store }) => store.getState().query.filters.length > 0,
    menus: [],
    run: ({ store }) => store.getState().clearFilters(),
  });
}

/**
 * One palette command per registered sort — called after sources register,
 * so their scope-specific sorts (hot, relevance) get commands too.
 */
export function registerSortCommands(): void {
  for (const provider of allSorts()) {
    // Parameterized sorts (similarity) register their own commands that
    // collect the parameter; a bare "Sort by closest" would do nothing.
    if (provider.param !== null) continue;
    registerCommand({
      id: `sort.${provider.id}`,
      title: `Sort by ${provider.label}`,
      keywords: ["order", "invoke again to reverse"],
      when: (ctx) => {
        const state = ctx.store.getState();
        return state.entries.length > 0 && provider.appliesTo(state.scope);
      },
      menus: [],
    run: ({ store }) => store.getState().sortBy(provider.id),
    });
  }
}
