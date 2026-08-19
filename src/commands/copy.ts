import { tempDir } from "@tauri-apps/api/path";

import { copyFiles, developEditedPaths, developExport, type ExifSource } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { candidatesOf, jpegOf, type Candidate } from "../state/export";
import { chosenEntries, hdrOf, useAppStore } from "../state/store";

/* Copy sends exactly the photographs shown — never the whole stack, unlike rating and deleting. */

type CopyStep =
  | { kind: "file"; path: string }
  | { kind: "render"; path: string; exif: ExifSource };

export function copyPlan(candidates: Candidate[]): CopyStep[] {
  return candidates.map((candidate) => {
    if (!candidate.edited && !candidate.hdr) {
      return { kind: "file", path: candidate.entry.path };
    }
    // Renders take the sibling JPEG's EXIF where there is one.
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

  // Asked over the whole stack so a raw's crop counts for its stand-in JPEG (same rule as the export dialog).
  const edited = new Set(
    await developEditedPaths(state.entries.map((e) => e.path)).catch(() => []),
  );
  const hdrFaces = new Set(hdrOf(state).byFace.keys());
  const plan = copyPlan(candidatesOf(photographs, state.entries, edited, hdrFaces));

  // developExport never overwrites, so repeated copies of a re-edited photograph keep their versions.
  const folder = await tempDir();

  const paths: string[] = [];
  // Serial on purpose: each render holds a sensor's worth of floats, and the pipeline is parallel inside.
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
      // A failed render falls back to the original file.
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
    menus: [{ menu: "image", section: "transfer", submenu: null, label: "Copy" }],
    when: (ctx: CommandContext) => {
      const s = ctx.store.getState();
      // With text selected the command is inapplicable, so ⌘C falls through to the browser.
      const textSelected = !(window.getSelection()?.isCollapsed ?? true);
      return s.scope?.kind === "folder" && s.selection.length > 0 && !textSelected;
    },
    run: copySelection,
  });
}
