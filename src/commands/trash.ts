import { confirm, message } from "@tauri-apps/plugin-dialog";

import { deleteFiles, type FileEntry } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { chosenEntries, filesBehind, useAppStore } from "../state/store";

/**
 * Deleting — the only thing the app does that reaches the user's photographs.
 *
 * Everything else it writes is app-local: edits and labels live in its own
 * database, exports go where a save dialog says. So this one goes out of its
 * way to be un-frightening: it moves files to the platform Trash rather than
 * unlinking them, it names what it is about to take before it takes anything,
 * and it asks every single time. There is no "don't ask again", because the
 * answer is not a preference — it is the whole safeguard.
 *
 * It also drops only the files that actually went. The folder watcher would
 * notice eventually, but "eventually" is not good enough when the photograph
 * you deleted is still on screen, and a file that failed to move must stay
 * listed, because it is still there.
 */

/** Up to this many names in the confirmation; past it, a count. */
const NAMED = 8;

/** What the confirmation says it is about to do. */
export function trashPrompt(photographs: FileEntry[], files: FileEntry[]): string {
  const what =
    photographs.length === 1 ? "this photograph" : `these ${photographs.length} photographs`;
  // Only worth saying when the two numbers differ — which is exactly when a
  // stacked pair means more files go than there are frames on screen.
  const extra =
    files.length === photographs.length
      ? ""
      : ` — ${files.length} files, raw and JPEG together —`;
  const named = files.slice(0, NAMED).map((f) => f.name);
  const rest = files.length - named.length;
  const list = rest > 0 ? [...named, `and ${rest} more`] : named;
  return `Move ${what}${extra} to the Trash?\n\n${list.join("\n")}`;
}

async function trashSelection(): Promise<void> {
  const state = useAppStore.getState();
  const photographs = chosenEntries(state);
  if (photographs.length === 0) return;
  const files = filesBehind(state, photographs);

  const go = await confirm(trashPrompt(photographs, files), {
    title: "Move to Trash",
    kind: "warning",
    okLabel: "Move to Trash",
    cancelLabel: "Cancel",
  });
  if (!go) return;

  const outcome = await deleteFiles(files.map((f) => f.path));
  useAppStore.getState().deleted(outcome.removed);
  if (outcome.failed.length > 0) {
    // Said plainly rather than swallowed: a file that would not move is
    // still on the card, and the gallery is still showing it.
    const lines = outcome.failed.map((f) => `${f.path.split("/").pop() ?? f.path}: ${f.error}`);
    await message(lines.join("\n"), { title: "Some files stayed where they were", kind: "error" });
  }
}

export function registerTrashCommands(): void {
  registerCommand({
    id: "image.trash",
    title: "Move to Trash",
    keywords: ["delete", "remove", "bin", "discard", "reject", "cull"],
    menus: [{ menu: "image", section: "danger", submenu: null, label: "Move to Trash" }],
    // Only where there are files to move: a remote source's images are not
    // the user's to delete, and nothing outside the selection is ever touched.
    when: (ctx: CommandContext) => {
      const s = ctx.store.getState();
      return s.scope?.kind === "folder" && s.selection.length > 0;
    },
    run: trashSelection,
  });
}
