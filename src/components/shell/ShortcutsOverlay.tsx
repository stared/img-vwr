import { useEffect, useMemo, useRef, useState } from "react";

import { allCommands } from "../../registry/commands";
import { defaultKeybindings, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

/** The `?` cheatsheet: every bound command, grouped and searchable —
 * rendered from the command and keybinding registries. */

/** Sheet section per command id prefix. */
const SECTIONS: { title: string; prefixes: string[] }[] = [
  { title: "Navigate", prefixes: ["image", "scene", "selection"] },
  { title: "Views", prefixes: ["view"] },
  { title: "Viewer", prefixes: ["viewer"] },
  { title: "Rate & tag", prefixes: ["labels"] },
  { title: "Develop", prefixes: ["develop"] },
  { title: "Find & filter", prefixes: ["filter"] },
  { title: "App", prefixes: ["folder", "palette", "sidebar", "inspector", "help"] },
];
/** Bindings whose prefix no section claims land here, never dropped. */
const OTHER = "Other";

interface SheetRow {
  title: string;
  chords: string[];
}

function sheetSections(): { title: string; rows: SheetRow[] }[] {
  const chordsByCommand = new Map<string, string[]>();
  for (const [chord, id] of defaultKeybindings) {
    chordsByCommand.set(id, [...(chordsByCommand.get(id) ?? []), chord]);
  }
  const titles = new Map(allCommands().map((c) => [c.id, c.title]));
  const claimed = new Set(SECTIONS.flatMap((s) => s.prefixes));
  const rowsFor = (prefixes: string[] | null): SheetRow[] =>
    [...chordsByCommand.entries()]
      .filter(([id]) => {
        const prefix = id.split(".")[0] ?? "";
        return prefixes === null ? !claimed.has(prefix) : prefixes.includes(prefix);
      })
      .map(([id, chords]) => ({
        title: titles.get(id) ?? id,
        chords: chords.map(formatChord),
      }));
  return [
    ...SECTIONS.map((s) => ({ title: s.title, rows: rowsFor(s.prefixes) })),
    { title: OTHER, rows: rowsFor(null) },
  ].filter((s) => s.rows.length > 0);
}

export function ShortcutsOverlay() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      inputRef.current?.focus();
    }
  }, [open]);

  // Esc clears the search first, then closes; `?` closes unless typed into
  // the search box. Capture, ahead of the global handler.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const input = inputRef.current;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (input !== null && input === document.activeElement && input.value !== "") {
          setQuery("");
        } else {
          setOpen(false);
        }
      } else if (e.key === "?" && e.target !== inputRef.current) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, setOpen]);

  const groups = useMemo(() => (open ? sheetSections() : []), [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const shown = groups
    .map((s) => ({
      ...s,
      rows: s.rows.filter((r) => q === "" || r.title.toLowerCase().includes(q)),
    }))
    .filter((s) => s.rows.length > 0);

  return (
    <div className="palette-backdrop shortcuts-backdrop" onClick={() => setOpen(false)}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <input
            ref={inputRef}
            value={query}
            placeholder="filter…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="shortcuts-body">
          {shown.map((s) => (
            <section key={s.title} className="shortcuts-group">
              <h3>{s.title}</h3>
              {s.rows.map((row) => (
                <div key={row.title} className="shortcut-row">
                  <span>{row.title}</span>
                  <span className="shortcut-keys">
                    {row.chords.map((chord) => (
                      <kbd key={chord}>{chord}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {shown.length === 0 && <p className="shortcuts-empty">Nothing matches</p>}
        </div>
        <p className="shortcuts-foot">
          Every command, bound or not, is in the palette — <kbd>⌘K</kbd>
        </p>
      </div>
    </div>
  );
}
