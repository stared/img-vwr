import { Fragment, useEffect, useState } from "react";

import { executeCommand, getCommand, menuEntries, type MenuEntry } from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useDevelopStore } from "../../state/develop";
import { useAppStore } from "../../state/store";

const MENU_WIDTH = 200;
const MENU_MAX_HEIGHT = 320;

export function ImageContextMenu() {
  const pos = useAppStore((s) => s.imageMenu);
  const setImageMenu = useAppStore((s) => s.setImageMenu);
  // Bare subscriptions: enablement reads this state via getState(), so subscribe to keep grayed rows live.
  useDevelopStore((s) => s.session !== null);
  useDevelopStore((s) => s.copied !== null);
  const [submenu, setSubmenu] = useState<string | null>(null);

  useEffect(() => setSubmenu(null), [pos]);

  // Capture phase so Escape doesn't reach the global keybindings and close the viewer behind the menu.
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
  const row = ({ command, placement, enabled }: MenuEntry) => (
    <button key={command.id} disabled={!enabled} onClick={() => pick(command.id)}>
      {placement.label}
      <span className="menu-hint">{chordHint(command.id)}</span>
    </button>
  );

  const seen = new Set<string>();
  const topLevel = entries.flatMap((entry) => {
    const sub = entry.placement.submenu;
    if (sub === null) return [entry];
    if (seen.has(sub)) return [];
    seen.add(sub);
    return [entry];
  });
  const submenuEnabled = (title: string) =>
    entries.some((e) => e.placement.submenu === title && e.enabled);

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
          topLevel.map((entry, i) => {
            const previous = topLevel[i - 1];
            const key = entry.placement.submenu ?? entry.command.id;
            return (
              <Fragment key={key}>
                {previous !== undefined &&
                  previous.placement.section !== entry.placement.section && (
                    <div className="menu-sep" />
                  )}
                {entry.placement.submenu === null ? (
                  row(entry)
                ) : (
                  <button
                    disabled={!submenuEnabled(entry.placement.submenu)}
                    onClick={() => setSubmenu(entry.placement.submenu)}
                  >
                    {entry.placement.submenu}
                    <span className="menu-hint">›</span>
                  </button>
                )}
              </Fragment>
            );
          })
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
