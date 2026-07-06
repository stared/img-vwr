import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCommandsForTest,
  executeCommand,
  fuzzyScore,
  registerCommand,
  searchCommands,
  type CommandContext,
} from "./commands";

const ctx = { store: null } as unknown as CommandContext;

describe("command registry", () => {
  beforeEach(clearCommandsForTest);

  it("rejects duplicate ids", () => {
    registerCommand({ id: "a", title: "A", run: () => {} });
    expect(() => registerCommand({ id: "a", title: "A again", run: () => {} })).toThrow(
      /already registered/,
    );
  });

  it("executes and reports missing commands", () => {
    let ran = 0;
    registerCommand({ id: "a", title: "A", run: () => void (ran += 1) });
    expect(executeCommand("a", ctx)).toBe(true);
    expect(ran).toBe(1);
    expect(executeCommand("nope", ctx)).toBe(false);
  });

  it("respects the when guard", () => {
    registerCommand({ id: "guarded", title: "G", when: () => false, run: () => {} });
    expect(executeCommand("guarded", ctx)).toBe(false);
  });
});

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("zf", "Zoom to Fit")).not.toBeNull();
    expect(fuzzyScore("xyz", "Zoom to Fit")).toBeNull();
  });

  it("prefers word-start and consecutive matches", () => {
    const wordStart = fuzzyScore("fit", "Zoom to Fit");
    const scattered = fuzzyScore("fit", "insufficient throughput");
    expect(wordStart).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(wordStart ?? 0).toBeGreaterThan(scattered ?? 0);
  });

  it("empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("searchCommands", () => {
  beforeEach(clearCommandsForTest);

  it("ranks better matches first and hides guarded commands", () => {
    registerCommand({ id: "viewer.zoomFit", title: "Zoom to Fit", run: () => {} });
    registerCommand({ id: "folder.open", title: "Open Folder", run: () => {} });
    registerCommand({ id: "hidden", title: "Zoom Fit Hidden", when: () => false, run: () => {} });

    const results = searchCommands("fit", ctx).map((c) => c.id);
    expect(results[0]).toBe("viewer.zoomFit");
    expect(results).not.toContain("hidden");
  });
});
