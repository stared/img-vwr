import { tempDir } from "@tauri-apps/api/path";

import { copyFiles, developEditedPaths, developExport, type ExifSource } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { candidatesOf, jpegOf, type Candidate } from "../state/export";
import { chosenEntries, hdrOf, useAppStore } from "../state/store";

/**
 * Copying puts the selected photographs on the system clipboard as files —
 * paste in the Finder and they are copied there, paste into a chat and they
 * are attached.
 *
 * What leaves is what the screen shows. For an untouched photograph that is
 * the file itself, byte for byte. For an edited one the file would be a lie
 * — the crop and the develop are the photograph now — so the edit is
 * rendered to a JPEG in the system temp folder and *that* is what goes on
 * the clipboard, exactly as an export would produce it. Same for an HDR
 * face, where the file at the path is one exposure of a fusion.
 *
 * Exactly the photographs shown, NOT the whole stack: what should arrive in
 * a chat is the picture being looked at, not the raw negative riding along
 * as a surprise attachment. The both-files reach stays with rating and
 * deleting, where acting on half a photograph would be the bug.
 */

/** What one copied photograph leaves as: a file it already is, or a render. */
export type CopyStep =
  | { kind: "file"; path: string }
  | { kind: "render"; path: string; exif: ExifSource };

export function copyPlan(candidates: Candidate[]): CopyStep[] {
  return candidates.map((candidate) => {
    if (!candidate.edited && !candidate.hdr) {
      return { kind: "file", path: candidate.entry.path };
    }
    // A rendered frame is given the sibling JPEG's metadata where there is
    // one, so what lands in a chat still says when and how it was taken.
    const jpeg = jpegOf(candidate);
    return {
      kind: "render",
      path: candidate.entry.path,
      exif: jpeg ? { kind: "file", path: jpeg.path } : { kind: "none" },
    };
  });
}

async function copySelection(): Promise<void> {
  const state = useAppStore.getState();
  const photographs = chosenEntries(state);
  if (photographs.length === 0) return;

  // Which of them carry an edit — asked over the whole stack, so a crop made
  // on the raw counts for the JPEG standing in front of it (same rule as the
  // export dialog's plan).
  const edited = new Set(
    await developEditedPaths(state.entries.map((e) => e.path)).catch(() => []),
  );
  const hdrFaces = new Set(hdrOf(state).byFace.keys());
  const plan = copyPlan(candidatesOf(photographs, state.entries, edited, hdrFaces));

  // The OS temp folder, because a render needs somewhere real to write and a
  // clipboard file must outlive this function. The export machinery never
  // overwrites, so repeated copies of a re-edited photograph each hand over
  // the version they were copied at.
  const folder = await tempDir();

  const paths: string[] = [];
  // Serial like the export dialog's loop: each render holds a sensor's worth
  // of floats, and the pipeline is already parallel inside.
  for (const step of plan) {
    if (step.kind === "file") {
      paths.push(step.path);
      continue;
    }
    try {
      const rendered = await developExport(
        { kind: "render", path: step.path, exif: step.exif },
        { folder, format: { kind: "jpeg", quality: 90 }, size: { kind: "full" } },
      );
      paths.push(rendered.path);
    } catch {
      // A render that failed still owes the clipboard something; the
      // original file is the honest fallback for a photograph whose edit
      // could not be produced.
      paths.push(step.path);
    }
  }
  if (paths.length > 0) await copyFiles(paths);
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
