import { useEffect, useMemo, useRef, useState } from "react";

import {
  executeCommand,
  searchCommands,
  type Command,
  type CommandContext,
} from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

export function CommandPalette() {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /** Command waiting for its text argument; the input switches to arg mode. */
  const [pending, setPending] = useState<Command | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ctx: CommandContext = useMemo(() => ({ store: useAppStore }), []);
  const results = useMemo(
    () =>
      paletteOpen && !pending
        ? searchCommands(query, ctx).filter((c) => c.id !== "palette.open")
        : [],
    [paletteOpen, pending, query, ctx],
  );

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setCursor(0);
      setPending(null);
      inputRef.current?.focus();
    }
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  const run = (command: Command) => {
    if (command.input) {
      // Two-step command: keep the palette open and collect the argument.
      setPending(command);
      setQuery("");
      inputRef.current?.focus();
      return;
    }
    setPaletteOpen(false);
    executeCommand(command.id, ctx);
  };

  const runPending = () => {
    if (!pending || query.trim() === "") return;
    setPaletteOpen(false);
    executeCommand(pending.id, ctx, query.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // In arg mode, Esc backs out to the command list first.
      if (pending) {
        setPending(null);
        setQuery("");
      } else setPaletteOpen(false);
    } else if (e.key === "Enter" && pending) runPending();
    else if (e.key === "ArrowDown") setCursor((c) => Math.min(results.length - 1, c + 1));
    else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (e.key === "Enter") {
      const chosen = results[cursor];
      if (chosen) run(chosen);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          {pending && <span className="palette-pending">{pending.title}</span>}
          <input
            ref={inputRef}
            value={query}
            placeholder={pending ? pending.input?.placeholder : "Type a command…"}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {!pending && (
          <ul>
            {results.map((command, i) => (
              <li
                key={command.id}
                className={i === cursor ? "active" : ""}
                onMouseEnter={() => setCursor(i)}
                onClick={() => run(command)}
              >
                <span>{command.title}</span>
                <span className="palette-chords">
                  {chordsForCommand(command.id).map(formatChord).join(" ")}
                </span>
              </li>
            ))}
            {results.length === 0 && <li className="palette-empty">No matching commands</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
