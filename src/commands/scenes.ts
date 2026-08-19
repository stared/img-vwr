import { registerCommand, type CommandContext } from "../registry/commands";
import { groupScenes, sceneJumpTarget } from "../state/scenes";
import { sceneSimsFor, useAppStore, visibleOf } from "../state/store";

function jumpScene(direction: 1 | -1): void {
  const s = useAppStore.getState();
  const visible = visibleOf(s, s.query);
  // Must group exactly as the grid draws, embedding refinement included.
  const scenes = groupScenes(
    visible,
    s.meta,
    s.sceneGapMin * 60_000,
    s.sceneContentWeight,
    sceneSimsFor(s, visible),
  );
  const target = sceneJumpTarget(scenes, s.selectedIndex, direction);
  if (target !== null) s.select(target);
}

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
