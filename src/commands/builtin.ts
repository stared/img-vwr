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
    run: async ({ store }) => {
      const selected = await open({ directory: true, title: "Open Folder" });
      if (typeof selected === "string") {
        await store.getState().openFolder(selected);
      }
    },
  });

  registerCommand({
    id: "palette.open",
    title: "Command Palette",
    keywords: ["commands", "search"],
    run: ({ store }) => store.getState().setPaletteOpen(true),
  });

  registerCommand({
    id: "sidebar.toggle",
    title: "Toggle Sidebar",
    run: ({ store }) => store.getState().toggleSidebar(),
  });

  registerCommand({
    id: "stats.toggle",
    title: "Toggle Statistics",
    keywords: ["histogram", "exif", "panel"],
    run: ({ store }) => store.getState().toggleStats(),
  });

  registerCommand({
    id: "gallery.map",
    title: "Toggle Map View",
    keywords: ["geo", "gps", "location", "grid"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    run: ({ store }) => {
      const { galleryLayout, setGalleryLayout } = store.getState();
      setGalleryLayout(galleryLayout === "grid" ? "map" : "grid");
    },
  });

  registerCommand({
    id: "viewer.open",
    title: "Open Image",
    keywords: ["view", "show"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    run: ({ store }) => store.getState().openViewer(store.getState().selectedIndex),
  });

  registerCommand({
    id: "viewer.close",
    title: "Back to Gallery",
    keywords: ["escape", "grid"],
    when: inViewer,
    run: ({ store }) => store.getState().closeViewer(),
  });

  registerCommand({
    id: "image.next",
    title: "Next Image",
    when: hasImages,
    run: ({ store }) => store.getState().navigate(1),
  });

  registerCommand({
    id: "image.prev",
    title: "Previous Image",
    when: hasImages,
    run: ({ store }) => store.getState().navigate(-1),
  });

  registerCommand({
    id: "viewer.zoomIn",
    title: "Zoom In",
    when: inViewer,
    run: ({ store }) => store.getState().viewerZoom(ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomOut",
    title: "Zoom Out",
    when: inViewer,
    run: ({ store }) => store.getState().viewerZoom(1 / ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomFit",
    title: "Zoom to Fit",
    keywords: ["reset"],
    when: inViewer,
    run: ({ store }) => store.getState().viewerZoomFit(),
  });

  registerCommand({
    id: "viewer.zoomActual",
    title: "Zoom to 100%",
    keywords: ["actual size", "pixel"],
    when: inViewer,
    run: ({ store }) => store.getState().viewerZoomActual(),
  });

  registerCommand({
    id: "filter.find",
    title: "Find by Name…",
    keywords: ["search", "filter"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    run: ({ store }) => store.getState().setFindOpen(true),
  });

  for (const group of FORMAT_GROUPS) {
    registerCommand({
      id: `filter.format.${group.id}`,
      title: `Filter: ${group.label}`,
      keywords: ["type", "format", "toggle"],
      when: (ctx) => hasImages(ctx) && !inViewer(ctx),
      run: ({ store }) => store.getState().toggleFormatFilter(group.id),
    });
  }

  registerCommand({
    id: "filter.clear",
    title: "Clear Filters",
    when: ({ store }) => store.getState().query.filters.length > 0,
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
      run: ({ store }) => store.getState().sortBy(provider.id),
    });
  }
}
