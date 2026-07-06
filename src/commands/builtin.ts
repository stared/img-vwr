import { open } from "@tauri-apps/plugin-dialog";

import { registerCommand, type CommandContext } from "../registry/commands";

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
}
