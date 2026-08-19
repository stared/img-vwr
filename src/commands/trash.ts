import { confirm, message } from "@tauri-apps/plugin-dialog";

import { deleteFiles, type FileEntry } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { chosenEntries, filesBehind, useAppStore } from "../state/store";

/* Deleting always confirms — deliberately no "don't ask again" — and drops only files that actually moved. */

/** Up to this many names in the confirmation; past it, a count. */
const NAMED = 8;

export function trashPrompt(photographs: FileEntry[], files: FileEntry[]): string {
  const what =
    photographs.length === 1 ? "this photograph" : `these ${photographs.length} photographs`;
  // files > photographs exactly when a stack sends raw and JPEG together.
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
    when: (ctx: CommandContext) => {
      const s = ctx.store.getState();
      return s.scope?.kind === "folder" && s.selection.length > 0;
    },
    run: trashSelection,
  });
}
