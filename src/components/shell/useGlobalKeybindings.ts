import { useEffect } from "react";

import { executeCommand, type CommandContext } from "../../registry/commands";
import { commandForEvent } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

/** The single window keydown handler: chord → command id → registry. */
export function useGlobalKeybindings() {
  useEffect(() => {
    const ctx: CommandContext = { store: useAppStore };
    const onKeyDown = (e: KeyboardEvent) => {
      // The palette owns the keyboard while open; typing fields keep their keys.
      if (useAppStore.getState().paletteOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      const commandId = commandForEvent(e);
      if (commandId && executeCommand(commandId, ctx)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
