/**
 * Keybinding layer: chord string → command id, resolved by one global
 * keydown handler. "mod" is ⌘ on macOS (mapped to metaKey) — a future
 * user/plugin keymap merges over `defaultKeybindings`.
 */

export interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** Parse "mod+shift+k" → structured chord. Key names follow KeyboardEvent.key, lowercased. */
export function parseChord(spec: string): Chord {
  const parts = spec.toLowerCase().split("+");
  // A trailing "+" (e.g. "+" or "mod++") means the key itself is "+".
  const key = spec.endsWith("+") ? "+" : (parts[parts.length - 1] ?? "");
  return {
    key,
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

export function eventMatchesChord(e: KeyboardEvent, chord: Chord): boolean {
  return (
    e.key.toLowerCase() === chord.key &&
    (e.metaKey || e.ctrlKey) === chord.mod &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt
  );
}

export const defaultKeybindings: ReadonlyMap<string, string> = new Map([
  ["mod+k", "palette.open"],
  ["mod+p", "palette.open"],
  ["mod+o", "folder.open"],
  ["mod+b", "sidebar.toggle"],
  ["mod+i", "stats.toggle"],
  ["f", "filter.find"],
  ["mod+f", "filter.find"],
  ["arrowright", "image.next"],
  ["arrowleft", "image.prev"],
  ["enter", "viewer.open"],
  ["escape", "viewer.close"],
  ["=", "viewer.zoomIn"],
  ["+", "viewer.zoomIn"],
  ["-", "viewer.zoomOut"],
  // Zoom presets follow Preview.app; bare digits rate (Lightroom-style).
  ["mod+0", "viewer.zoomFit"],
  ["mod+1", "viewer.zoomActual"],
  ["0", "labels.stars.0"],
  ["1", "labels.stars.1"],
  ["2", "labels.stars.2"],
  ["3", "labels.stars.3"],
  ["4", "labels.stars.4"],
  ["5", "labels.stars.5"],
  ["t", "labels.tag"],
]);

/** First binding whose chord matches the event, or null. */
export function commandForEvent(
  e: KeyboardEvent,
  bindings: ReadonlyMap<string, string> = defaultKeybindings,
): string | null {
  for (const [spec, commandId] of bindings) {
    if (eventMatchesChord(e, parseChord(spec))) {
      return commandId;
    }
  }
  return null;
}

/** Chords bound to a command, for display in the palette ("⌘K"). */
export function chordsForCommand(
  commandId: string,
  bindings: ReadonlyMap<string, string> = defaultKeybindings,
): string[] {
  return [...bindings.entries()].filter(([, id]) => id === commandId).map(([spec]) => spec);
}

export function formatChord(spec: string): string {
  return spec
    .split("+")
    .map((part) => {
      switch (part) {
        case "mod":
          return "⌘";
        case "shift":
          return "⇧";
        case "alt":
          return "⌥";
        case "escape":
          return "Esc";
        case "enter":
          return "↵";
        case "arrowleft":
          return "←";
        case "arrowright":
          return "→";
        default:
          return part.toUpperCase();
      }
    })
    .join("");
}
