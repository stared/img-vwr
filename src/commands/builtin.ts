import { open } from "@tauri-apps/plugin-dialog";

import { registerCommand, type CommandContext } from "../registry/commands";
import { allSorts } from "../registry/sorts";
import { FORMAT_GROUPS } from "../state/query";
import { allViews } from "../registry/views";

const ZOOM_STEP = 1.25;

function inViewer(ctx: CommandContext): boolean {
  return ctx.store.getState().viewMode === "viewer";
}

function hasImages(ctx: CommandContext): boolean {
  return ctx.store.getState().entries.length > 0;
}

export function registerBuiltinCommands(): void {
  registerCommand({
    id: "folder.open",
    title: "Open Folder…",
    input: null,
    when: () => true,
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
    input: null,
    when: () => true,
    keywords: ["commands", "search"],
    menus: [],
    run: ({ store }) => store.getState().setPaletteOpen(true),
  });

  registerCommand({
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
    input: null,
    when: () => true,
    keywords: ["help", "keys", "cheatsheet", "bindings"],
    menus: [],
    run: ({ store }) => store.getState().setShortcutsOpen(!store.getState().shortcutsOpen),
  });

  registerCommand({
    id: "sidebar.toggle",
    title: "Toggle Sidebar",
    keywords: [],
    input: null,
    when: () => true,
    menus: [],
    run: ({ store }) => store.getState().toggleSidebar(),
  });

  registerCommand({
    id: "inspector.toggle",
    title: "Toggle Inspector",
    input: null,
    when: () => true,
    keywords: ["statistics", "histogram", "exif", "develop", "info", "right panel"],
    menus: [],
    run: ({ store }) => store.getState().toggleInspector(),
  });

  for (const view of allViews()) {
    registerCommand({
      id: `view.${view.id}`,
      title: `${view.label} View`,
      input: null,
      keywords: view.keywords,
      when: hasImages,
      menus: [],
      run: ({ store }) => {
        const state = store.getState();
        if (state.viewMode === "viewer") state.closeViewer();
        store.getState().setGalleryLayout(view.id);
      },
    });
  }

  registerCommand({
    id: "viewer.open",
    title: "Open Image",
    input: null,
    keywords: ["view", "show"],
    menus: [{ menu: "image", section: "open", submenu: null, label: "Open Image" }],
    when: (ctx) => ctx.store.getState().selectedIndex !== null && !inViewer(ctx),
    run: ({ store }) => {
      const { selectedIndex, openViewer } = store.getState();
      if (selectedIndex !== null) openViewer(selectedIndex);
    },
  });

  registerCommand({
    id: "selection.all",
    title: "Select All",
    input: null,
    keywords: ["every", "everything", "whole folder", "multiple"],
    menus: [],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    run: ({ store }) => store.getState().selectAll(),
  });

  registerCommand({
    id: "selection.clear",
    title: "Clear Selection",
    input: null,
    keywords: ["deselect", "escape", "none"],
    menus: [],
    when: (ctx) => ctx.store.getState().selectedIndex !== null,
    run: ({ store }) => store.getState().select(null),
  });

  registerCommand({
    id: "viewer.close",
    title: "Back to Gallery",
    input: null,
    keywords: ["escape", "grid"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().closeViewer(),
  });

  registerCommand({
    id: "image.next",
    title: "Next Image",
    keywords: [],
    input: null,
    when: hasImages,
    menus: [],
    run: ({ store }) => store.getState().navigate(1),
  });

  registerCommand({
    id: "image.prev",
    title: "Previous Image",
    keywords: [],
    input: null,
    when: hasImages,
    menus: [],
    run: ({ store }) => store.getState().navigate(-1),
  });

  registerCommand({
    id: "image.below",
    title: "Image Below",
    input: null,
    keywords: ["down", "row"],
    when: (ctx) => hasImages(ctx) && ctx.store.getState().rowNavigator !== null,
    menus: [],
    run: ({ store }) => store.getState().rowNavigator?.(1),
  });

  registerCommand({
    id: "image.above",
    title: "Image Above",
    input: null,
    keywords: ["up", "row"],
    when: (ctx) => hasImages(ctx) && ctx.store.getState().rowNavigator !== null,
    menus: [],
    run: ({ store }) => store.getState().rowNavigator?.(-1),
  });

  registerCommand({
    id: "viewer.zoomIn",
    title: "Zoom In",
    keywords: [],
    input: null,
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoom(ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomOut",
    title: "Zoom Out",
    keywords: [],
    input: null,
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoom(1 / ZOOM_STEP),
  });

  registerCommand({
    id: "viewer.zoomFit",
    title: "Zoom to Fit",
    input: null,
    keywords: ["reset"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoomFit(),
  });

  registerCommand({
    id: "viewer.zoomActual",
    title: "Zoom to 100%",
    input: null,
    keywords: ["actual size", "pixel"],
    when: inViewer,
    menus: [],
    run: ({ store }) => store.getState().viewerZoomActual(),
  });

  registerCommand({
    id: "filter.find",
    title: "Find by Name…",
    input: null,
    keywords: ["search", "filter"],
    when: (ctx) => hasImages(ctx) && !inViewer(ctx),
    menus: [],
    run: ({ store }) => store.getState().setFindOpen(true),
  });

  for (const group of FORMAT_GROUPS) {
    registerCommand({
      id: `filter.format.${group.id}`,
      title: `Filter: ${group.label}`,
      input: null,
      keywords: ["type", "format", "toggle"],
      when: (ctx) => hasImages(ctx) && !inViewer(ctx),
      menus: [],
    run: ({ store }) => store.getState().toggleFormatFilter(group.id),
    });
  }

  registerCommand({
    id: "filter.clear",
    title: "Clear Filters",
    keywords: [],
    input: null,
    when: ({ store }) => store.getState().query.filters.length > 0,
    menus: [],
    run: ({ store }) => store.getState().clearFilters(),
  });
}

/** Must run after sources register, so their scope-specific sorts get commands too. */
export function registerSortCommands(): void {
  for (const provider of allSorts()) {
    // Parameterized sorts register their own parameter-collecting commands.
    if (provider.param !== null) continue;
    registerCommand({
      id: `sort.${provider.id}`,
      title: `Sort by ${provider.label}`,
      input: null,
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
