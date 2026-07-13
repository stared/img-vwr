import { useEffect } from "react";

import { executeCommand, getCommand, menuCommands } from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

const MENU_WIDTH = 200;
const MENU_MAX_HEIGHT = 320;

/**
 * Right-click menu on an image: every applicable command that declared
 * `menus: ["image"]`, with its keyboard shortcut as the hint — the menu is
 * how the shortcuts are discovered. Purely registry-driven: plugins' image
 * actions appear here by registration, nothing is listed by hand.
 */
export function ImageContextMenu() {
  const pos = useAppStore((s) => s.imageMenu);
  const setImageMenu = useAppStore((s) => s.setImageMenu);

  // Escape closes the menu without reaching the global keybindings
  // (which would e.g. also close the viewer behind it).
  useEffect(() => {
    if (!pos) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setImageMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [pos, setImageMenu]);

  if (!pos) return null;

  const ctx = { store: useAppStore };
  const commands = menuCommands("image", ctx);
  const close = () => setImageMenu(null);
  const pick = (id: string) => {
    close();
    // Same rule as chords: argument-taking commands collect in the palette.
    if (getCommand(id)?.input) useAppStore.getState().promptCommand(id);
    else executeCommand(id, ctx);
  };

  const left = Math.min(pos.x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(pos.y, window.innerHeight - MENU_MAX_HEIGHT - 8);

  return (
    <>
      <div
        className="menu-backdrop"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div className="filter-menu context-menu" style={{ left, top }}>
        {commands.map((command) => (
          <button key={command.id} onClick={() => pick(command.id)}>
            {command.title}
            <span className="menu-hint">
              {chordsForCommand(command.id).map(formatChord)[0] ?? ""}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
