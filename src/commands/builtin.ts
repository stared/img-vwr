import { open } from "@tauri-apps/plugin-dialog";

import { registerCommand, type CommandContext } from "../registry/commands";
import { allSorts } from "../registry/sorts";
import { FORMAT_GROUPS } from "../state/query";

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

  registerCommand({
    id: "gallery.map",
    title: "Toggle Map View",
    keywords: ["geo", "gps", "location", "grid"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    menus: [],
    run: ({ store }) => {
      const { galleryLayout, setGalleryLayout } = store.getState();
      setGalleryLayout(galleryLayout === "map" ? "grid" : "map");
    },
  });

  registerCommand({
    id: "gallery.timeline",
    title: "Toggle Timeline View",
    keywords: ["date", "taken", "time", "chronological", "grid"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    menus: [],
    run: ({ store }) => {
      const { galleryLayout, setGalleryLayout } = store.getState();
      setGalleryLayout(galleryLayout === "timeline" ? "grid" : "timeline");
    },
  });

  registerCommand({
    id: "gallery.darkroom",
    title: "Toggle Darkroom View",
    keywords: ["develop", "edit", "filmstrip", "lightroom", "grid"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    menus: [],
    run: ({ store }) => {
      const { galleryLayout, setGalleryLayout } = store.getState();
      setGalleryLayout(galleryLayout === "darkroom" ? "grid" : "darkroom");
    },
  });

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
