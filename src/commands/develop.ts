import { save } from "@tauri-apps/plugin-dialog";

import { developExport } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { useDevelopStore } from "../state/develop";

/** Suggested filename for an export: the original's stem, plus the format. */
export function exportName(path: string, extension: string): string {
  const base = path.split("/").pop() ?? "image";
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return `${stem}.${extension}`;
}

function hasSession(): boolean {
  return useDevelopStore.getState().session !== null;
}

/**
 * Develop commands. Export is the only path by which developed pixels leave
 * the app, and it always goes through a save dialog — nothing is ever written
 * beside the user's originals.
 */
export function registerDevelopCommands(): void {
  registerCommand({
    id: "develop.export",
    title: "Export Developed Image…",
    keywords: ["save", "jpeg", "png", "render", "develop"],
    menus: [{ menu: "image", submenu: null, label: "Export developed…" }],
    when: hasSession,
    run: async () => {
      const session = useDevelopStore.getState().session;
      if (!session) return;
      const destination = await save({
        title: "Export developed image",
        defaultPath: exportName(session.path, "jpg"),
        filters: [
          { name: "JPEG", extensions: ["jpg", "jpeg"] },
          { name: "PNG", extensions: ["png"] },
        ],
      });
      if (typeof destination !== "string") return;
      await developExport(session.path, session.settings, destination);
    },
  });

  registerCommand({
    id: "develop.reset",
    title: "Reset Develop Settings",
    keywords: ["revert", "neutral", "undo edit"],
    menus: [{ menu: "image", submenu: null, label: "Reset develop" }],
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
    menus: [{ menu: "image", submenu: null, label: "Copy develop settings" }],
    when: hasSession,
    run: () => {
      useDevelopStore.getState().copySettings();
    },
  });

  registerCommand({
    id: "develop.paste",
    title: "Paste Develop Settings",
    keywords: ["clipboard", "settings", "sync", "apply"],
    menus: [{ menu: "image", submenu: null, label: "Paste develop settings" }],
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
    menus: [{ menu: "image", submenu: null, label: "Auto tone" }],
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
      if (!store.getState().statsVisible) store.getState().toggleStats();
    },
  });
}
