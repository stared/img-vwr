import { copyFiles } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { chosenEntries, useAppStore } from "../state/store";

/**
 * Copying puts the selected photographs on the system clipboard as files —
 * paste in the Finder and they are copied there, paste into a chat and they
 * are attached.
 *
 * Exactly the files the screen shows, NOT the whole stack: copying is how a
 * photograph leaves for a chat or a folder, and what should arrive there is
 * the picture being looked at, not the raw negative riding along as a
 * surprise attachment. The both-files reach stays with rating and deleting,
 * where acting on half a photograph would be the bug.
 */
async function copySelection(): Promise<void> {
  const state = useAppStore.getState();
  const photographs = chosenEntries(state);
  if (photographs.length === 0) return;
  await copyFiles(photographs.map((f) => f.path));
}

export function registerCopyCommands(): void {
  registerCommand({
    id: "image.copy",
    title: "Copy",
    keywords: ["clipboard", "copy files", "share"],
    menus: [{ menu: "image", submenu: null, label: "Copy" }],
    when: (ctx: CommandContext) => {
      const s = ctx.store.getState();
      // Only local files can be handed to the clipboard — and never while
      // the user is copying text they selected somewhere in the window:
      // an inapplicable command lets ⌘C fall through to the browser.
      const textSelected = !(window.getSelection()?.isCollapsed ?? true);
      return s.scope?.kind === "folder" && s.selection.length > 0 && !textSelected;
    },
    run: copySelection,
  });
}
