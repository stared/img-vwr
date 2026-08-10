import { registerCommand, type CommandContext } from "../registry/commands";
import { groupScenes, sceneJumpTarget } from "../state/scenes";
import { sceneSimsFor, useAppStore, visibleOf } from "../state/store";

/**
 * Jumping by scene is what makes scenes a culling unit rather than
 * decoration: sweep a scene with the arrows, star the keepers or none, jump
 * on. The jump lands on the neighbouring scene's first photograph, in
 * whatever layout is showing — the grid scrolls to it, the darkroom's
 * filmstrip follows the selection anyway.
 */
function jumpScene(direction: 1 | -1): void {
  const s = useAppStore.getState();
  const visible = visibleOf(s, s.query);
  // The same scenes the grid draws — including the embedding refinement,
  // when its scores are fresh for this exact list.
  const scenes = groupScenes(visible, s.meta, s.sceneGapMin * 60_000, sceneSimsFor(s, visible));
  const target = sceneJumpTarget(scenes, s.selectedIndex, direction);
  if (target !== null) s.select(target);
}

/** Outside the scenes view there are no boundaries to jump — the chord
 * falls through. */
function scenesOn(ctx: CommandContext): boolean {
  const s = ctx.store.getState();
  return s.galleryLayout === "scenes" && s.entries.length > 0;
}

export function registerSceneCommands(): void {
  registerCommand({
    id: "scene.next",
    title: "Next Scene",
    keywords: ["jump", "group", "series", "burst"],
    menus: [],
    when: scenesOn,
    run: () => jumpScene(1),
  });

  registerCommand({
    id: "scene.prev",
    title: "Previous Scene",
    keywords: ["jump", "group", "series", "burst"],
    menus: [],
    when: scenesOn,
    run: () => jumpScene(-1),
  });
}
