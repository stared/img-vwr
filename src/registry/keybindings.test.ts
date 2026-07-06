import { describe, expect, it } from "vitest";

import { chordsForCommand, commandForEvent, eventMatchesChord, parseChord } from "./keybindings";

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

describe("commandForEvent", () => {
  it("resolves from a bindings map", () => {
    const bindings = new Map([
      ["mod+k", "palette.open"],
      ["escape", "viewer.close"],
    ]);
    expect(commandForEvent(keyEvent({ key: "k", metaKey: true }), bindings)).toBe("palette.open");
    expect(commandForEvent(keyEvent({ key: "Escape" }), bindings)).toBe("viewer.close");
    expect(commandForEvent(keyEvent({ key: "q" }), bindings)).toBeNull();
  });
});

describe("chordsForCommand", () => {
  it("finds every chord bound to a command", () => {
    const bindings = new Map([
      ["mod+k", "palette.open"],
      ["mod+p", "palette.open"],
    ]);
    expect(chordsForCommand("palette.open", bindings)).toEqual(["mod+k", "mod+p"]);
  });
});
