import { registerCommand, type CommandContext } from "../registry/commands";
import { useDevelopStore } from "../state/develop";
import { useAppStore } from "../state/store";

function hasSession(): boolean {
  return useDevelopStore.getState().session !== null;
}

/**
 * Develop commands. Export is the only path by which developed pixels leave
 * the app, and it always goes into a folder the user picks — nothing is ever
 * written beside the user's originals.
 */
export function registerDevelopCommands(): void {
  registerCommand({
    id: "develop.export",
    title: "Export…",
    keywords: ["save", "jpeg", "png", "render", "develop", "share"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Export…" }],
    // Everything selected, not just the one in the darkroom: exporting a take
    // is the ordinary case, and exporting one photograph is that with one
    // selected.
    when: (ctx: CommandContext) => {
      const s = ctx.store.getState();
      return s.scope?.kind === "folder" && s.selection.length > 0;
    },
    run: () => {
      useAppStore.getState().setExportOpen(true);
    },
  });

  registerCommand({
    id: "develop.crop",
    title: "Crop & Straighten",
    keywords: ["crop", "straighten", "rotate", "aspect", "trim"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Crop & Straighten" }],
    when: hasSession,
    run: () => {
      const s = useDevelopStore.getState();
      s.setCropping(!s.cropping);
    },
  });

  // Lightroom's contract for leaving the tool, and the one hands expect:
  // Enter keeps the crop on screen, Escape puts back the one it found. Both
  // are bound ahead of the keys' ordinary meanings and apply only mid-crop.
  registerCommand({
    id: "develop.cropDone",
    title: "Crop: Done",
    keywords: ["apply", "commit", "finish crop"],
    menus: [],
    when: () => useDevelopStore.getState().cropping,
    run: () => {
      useDevelopStore.getState().setCropping(false);
    },
  });

  registerCommand({
    id: "develop.cropCancel",
    title: "Crop: Cancel",
    keywords: ["revert crop", "undo crop", "abandon"],
    menus: [],
    when: () => useDevelopStore.getState().cropping,
    run: () => {
      useDevelopStore.getState().cancelCrop();
    },
  });

  registerCommand({
    id: "develop.reset",
    title: "Reset Develop Settings",
    keywords: ["revert", "neutral", "undo edit"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Reset Develop" }],
    when: hasSession,
    run: async () => {
      await useDevelopStore.getState().reset();
    },
  });

  registerCommand({
    id: "develop.focusMap",
    title: "Toggle Focus Map",
    keywords: ["sharpness", "overlay", "analysis", "in focus"],
    menus: [],
    when: hasSession,
    run: () => {
      const { session, setOverlay } = useDevelopStore.getState();
      if (!session) return;
      setOverlay(session.overlay === "sharpness" ? "none" : "sharpness");
    },
  });

  registerCommand({
    id: "develop.copy",
    title: "Copy Develop Settings",
    keywords: ["clipboard", "settings", "sync", "apply to"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Copy Develop Settings" }],
    when: hasSession,
    run: () => {
      useDevelopStore.getState().copySettings();
    },
  });

  registerCommand({
    id: "develop.paste",
    title: "Paste Develop Settings",
    keywords: ["clipboard", "settings", "sync", "apply"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Paste Develop Settings" }],
    when: () => hasSession() && useDevelopStore.getState().copied !== null,
    run: () => {
      useDevelopStore.getState().pasteSettings();
    },
  });

  registerCommand({
    id: "develop.compare",
    title: "Compare With Before",
    keywords: ["before", "after", "original", "toggle", "preview"],
    menus: [],
    when: hasSession,
    run: () => {
      useDevelopStore.getState().toggleComparing();
    },
  });

  registerCommand({
    id: "develop.autoTone",
    title: "Auto Tone",
    keywords: ["auto", "exposure", "brightness", "levels"],
    menus: [{ menu: "image", section: "develop", submenu: null, label: "Auto Tone" }],
    when: hasSession,
    run: async () => {
      await useDevelopStore.getState().autoTone();
    },
  });

  registerCommand({
    id: "develop.panel",
    title: "Show Develop Panel",
    keywords: ["exposure", "white balance", "edit"],
    menus: [],
    run: ({ store }: CommandContext) => {
      if (!store.getState().inspectorVisible) store.getState().toggleInspector();
    },
  });
}
