/**
 * Keybinding layer: chord string → command id, resolved by one global
 * keydown handler. "mod" is ⌘ on macOS (mapped to metaKey) — a future
 * user/plugin keymap merges over `defaultKeybindings`.
 *
 * A chord may be bound more than once. The handler tries each binding in
 * order and runs the first whose command is applicable, so one key can mean
 * different things in different contexts — Escape leaves the viewer when
 * there is a viewer to leave, and otherwise clears the selection. This is
 * why the table is a list rather than a map: a map could hold only one
 * meaning per key, and layering a plugin keymap over it would silently
 * discard the built-in fallbacks.
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

/** One chord bound to one command; order decides which wins. */
export type Keybinding = readonly [chord: string, commandId: string];

export const defaultKeybindings: readonly Keybinding[] = [
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
  ["mod+shift+c", "develop.copy"],
  ["mod+shift+v", "develop.paste"],
  // The photographer's habit: one key, held or tapped, to see what you had.
  ["\\", "develop.compare"],
  ["escape", "viewer.close"],
  // Falls through when there is no viewer to close.
  ["escape", "selection.clear"],
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
];

/**
 * Every command bound to this event, in table order. The caller runs the
 * first one that is applicable — resolving context is the command registry's
 * job (`when`), not this layer's.
 */
export function commandsForEvent(
  e: KeyboardEvent,
  bindings: readonly Keybinding[] = defaultKeybindings,
): string[] {
  return bindings
    .filter(([spec]) => eventMatchesChord(e, parseChord(spec)))
    .map(([, commandId]) => commandId);
}

/** Chords bound to a command, for display in the palette ("⌘K"). */
export function chordsForCommand(
  commandId: string,
  bindings: readonly Keybinding[] = defaultKeybindings,
): string[] {
  return bindings.filter(([, id]) => id === commandId).map(([spec]) => spec);
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
