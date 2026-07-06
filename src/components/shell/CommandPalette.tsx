import { useEffect, useMemo, useRef, useState } from "react";

import { executeCommand, searchCommands, type CommandContext } from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

export function CommandPalette() {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const ctx: CommandContext = useMemo(() => ({ store: useAppStore }), []);
  const results = useMemo(
    () => (paletteOpen ? searchCommands(query, ctx).filter((c) => c.id !== "palette.open") : []),
    [paletteOpen, query, ctx],
  );

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setCursor(0);
      inputRef.current?.focus();
    }
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  const run = (id: string) => {
    setPaletteOpen(false);
    executeCommand(id, ctx);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setPaletteOpen(false);
    else if (e.key === "ArrowDown") setCursor((c) => Math.min(results.length - 1, c + 1));
    else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (e.key === "Enter") {
      const chosen = results[cursor];
      if (chosen) run(chosen.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul>
          {results.map((command, i) => (
            <li
              key={command.id}
              className={i === cursor ? "active" : ""}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(command.id)}
            >
              <span>{command.title}</span>
              <span className="palette-chords">
                {chordsForCommand(command.id).map(formatChord).join(" ")}
              </span>
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
