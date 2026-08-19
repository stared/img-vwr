import { useEffect } from "react";

import { executeCommand, getCommand, type CommandContext } from "../../registry/commands";
import { commandsForEvent, focusOwnsKey } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

export function useGlobalKeybindings() {
  useEffect(() => {
    const ctx: CommandContext = { store: useAppStore };
    const onKeyDown = (e: KeyboardEvent) => {
      // A focused control keeps only the keys it uses, so a slider left focused doesn't swallow the app's keys.
      const { paletteOpen, shortcutsOpen } = useAppStore.getState();
      if (paletteOpen || shortcutsOpen) return;
      if (focusOwnsKey(e.target, e.key)) return;

      // A chord can be bound several times; the first applicable command wins.
      for (const commandId of commandsForEvent(e)) {
        // A chord on an argument-taking command collects it in the palette.
        const command = getCommand(commandId);
        if (command?.input) {
          if (!command.when || command.when(ctx)) {
            useAppStore.getState().promptCommand(commandId);
            e.preventDefault();
            return;
          }
          continue;
        }
        if (executeCommand(commandId, ctx)) {
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
