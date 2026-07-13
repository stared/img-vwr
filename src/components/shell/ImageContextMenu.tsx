import { useEffect, useState } from "react";

import { executeCommand, getCommand, menuEntries, type MenuEntry } from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

const MENU_WIDTH = 200;
const MENU_MAX_HEIGHT = 320;

/**
 * Right-click menu on an image: every applicable command that declared an
 * "image" placement, with its keyboard shortcut as the hint — the menu is
 * how the shortcuts are discovered. Placements sharing a submenu title
 * collapse under one row (Rating › nothing ★ ★★ …). Purely registry-driven:
 * plugins' image actions appear here by registration, nothing by hand.
 */
export function ImageContextMenu() {
  const pos = useAppStore((s) => s.imageMenu);
  const setImageMenu = useAppStore((s) => s.setImageMenu);
  const [submenu, setSubmenu] = useState<string | null>(null);

  // A fresh right-click always starts at the top level.
  useEffect(() => setSubmenu(null), [pos]);

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
  const entries = menuEntries("image", ctx);
  const close = () => setImageMenu(null);
  const pick = (id: string) => {
    close();
    // Same rule as chords: argument-taking commands collect in the palette.
    if (getCommand(id)?.input) useAppStore.getState().promptCommand(id);
    else executeCommand(id, ctx);
  };

  const chordHint = (id: string) => chordsForCommand(id).map(formatChord)[0] ?? "";
  const row = ({ command, placement }: MenuEntry) => (
    <button key={command.id} onClick={() => pick(command.id)}>
      {placement.label}
      <span className="menu-hint">{chordHint(command.id)}</span>
    </button>
  );

  // Top level: rows in registration order, each submenu as one row at the
  // position of its first member.
  const seen = new Set<string>();
  const topLevel = entries.flatMap((entry) => {
    const sub = entry.placement.submenu;
    if (sub === null) return [entry];
    if (seen.has(sub)) return [];
    seen.add(sub);
    return [entry];
  });

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
        {submenu === null ? (
          topLevel.map((entry) =>
            entry.placement.submenu === null ? (
              row(entry)
            ) : (
              <button key={`sub-${entry.placement.submenu}`} onClick={() => setSubmenu(entry.placement.submenu)}>
                {entry.placement.submenu}
                <span className="menu-hint">›</span>
              </button>
            ),
          )
        ) : (
          <>
            <button className="menu-back" onClick={() => setSubmenu(null)}>
              ‹ {submenu}
            </button>
            {entries.filter((e) => e.placement.submenu === submenu).map(row)}
          </>
        )}
      </div>
    </>
  );
}
