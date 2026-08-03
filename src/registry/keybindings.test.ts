import { describe, expect, it } from "vitest";

import {
  chordsForCommand,
  commandsForEvent,
  defaultKeybindings,
  eventMatchesChord,
  parseChord,
  type Keybinding,
} from "./keybindings";

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init } as KeyboardEvent;
}

describe("parseChord", () => {
  it("parses modifiers and key", () => {
    expect(parseChord("mod+shift+k")).toEqual({ key: "k", mod: true, shift: true, alt: false });
    expect(parseChord("escape")).toEqual({ key: "escape", mod: false, shift: false, alt: false });
    expect(parseChord("+")).toEqual({ key: "+", mod: false, shift: false, alt: false });
  });
});

describe("eventMatchesChord", () => {
  it("matches mod as meta or ctrl", () => {
    const chord = parseChord("mod+k");
    expect(eventMatchesChord(keyEvent({ key: "k", metaKey: true }), chord)).toBe(true);
    expect(eventMatchesChord(keyEvent({ key: "k", ctrlKey: true }), chord)).toBe(true);
    expect(eventMatchesChord(keyEvent({ key: "k" }), chord)).toBe(false);
  });

  it("rejects extra modifiers", () => {
    const chord = parseChord("arrowright");
    expect(eventMatchesChord(keyEvent({ key: "ArrowRight" }), chord)).toBe(true);
    expect(eventMatchesChord(keyEvent({ key: "ArrowRight", metaKey: true }), chord)).toBe(false);
  });
});

describe("commandsForEvent", () => {
  const bindings: Keybinding[] = [
    ["mod+k", "palette.open"],
    ["escape", "viewer.close"],
    ["escape", "selection.clear"],
  ];

  it("resolves from a bindings table", () => {
    expect(commandsForEvent(keyEvent({ key: "k", metaKey: true }), bindings)).toEqual([
      "palette.open",
    ]);
    expect(commandsForEvent(keyEvent({ key: "q" }), bindings)).toEqual([]);
  });

  it("returns every command on a chord, in table order", () => {
    // The caller runs the first applicable one, which is how Escape can mean
    // "leave the viewer" and "clear the selection" without ambiguity.
    expect(commandsForEvent(keyEvent({ key: "Escape" }), bindings)).toEqual([
      "viewer.close",
      "selection.clear",
    ]);
  });
});

describe("chordsForCommand", () => {
  it("finds every chord bound to a command", () => {
    const bindings: Keybinding[] = [
      ["mod+k", "palette.open"],
      ["mod+p", "palette.open"],
    ];
    expect(chordsForCommand("palette.open", bindings)).toEqual(["mod+k", "mod+p"]);
  });
});

describe("the shipped table", () => {
  it("resolves the develop chords, backslash included", () => {
    // Backslash has to survive being a string escape in the source, a chord
    // parse that splits on "+", and a KeyboardEvent's own `key`. Cheap to get
    // wrong at any of the three, and silent when it is.
    expect(commandsForEvent(keyEvent({ key: "\\" }), defaultKeybindings)).toEqual([
      "develop.compare",
    ]);
    expect(
      commandsForEvent(keyEvent({ key: "c", metaKey: true, shiftKey: true }), defaultKeybindings),
    ).toEqual(["develop.copy"]);
    expect(
      commandsForEvent(keyEvent({ key: "v", metaKey: true, shiftKey: true }), defaultKeybindings),
    ).toEqual(["develop.paste"]);
  });

  it("binds no chord to two commands that could both be applicable at once", () => {
    // Two bindings on one chord is deliberate (Escape), but only where the
    // `when` clauses are exclusive. A duplicate added by accident would make
    // one of them unreachable and nothing would say so.
    const seen = new Map<string, string[]>();
    for (const [chord, id] of defaultKeybindings) {
      seen.set(chord, [...(seen.get(chord) ?? []), id]);
    }
    const shared = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    expect(shared.map(([chord]) => chord)).toEqual(["escape"]);
  });
});
