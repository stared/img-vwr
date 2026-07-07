import { useEffect, useRef } from "react";

import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import { useAppStore } from "../../state/store";

/**
 * Linear-style filter row: invisible until a filter exists or find is open.
 * The folder is the scope — shown as the leading, non-removable chip.
 */
export function FilterBar() {
  const folderPath = useAppStore((s) => s.folderPath);
  const query = useAppStore((s) => s.query);
  const findOpen = useAppStore((s) => s.findOpen);
  const setNameFilter = useAppStore((s) => s.setNameFilter);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);

  const inputRef = useRef<HTMLInputElement>(null);
  const nameText = nameFilterText(query);
  const formats = activeFormats(query);
  const visible = folderPath !== null && (findOpen || query.filters.length > 0);

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  if (!visible) return null;

  const showFind = findOpen || nameText !== "";
  const folderName = folderPath.split("/").filter(Boolean).pop() ?? folderPath;

  return (
    <div className="filterbar">
      <span className="chip chip-scope" title={folderPath}>
        {folderName}
      </span>
      {showFind && (
        <span className="chip">
          name:
          <input
            ref={inputRef}
            value={nameText}
            placeholder="find…"
            onChange={(e) => setNameFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Esc: clear the text first; a second Esc dismisses the field.
              if (nameText) setNameFilter("");
              else setFindOpen(false);
              e.stopPropagation();
            }}
            onBlur={() => {
              if (!nameText) setFindOpen(false);
            }}
          />
        </span>
      )}
      {formats.map((group) => (
        <button
          key={group}
          className="chip chip-removable"
          title="remove filter"
          onClick={() => toggleFormatFilter(group)}
        >
          {FORMAT_GROUPS.find((g) => g.id === group)?.label ?? group}
          <span className="chip-x">×</span>
        </button>
      ))}
    </div>
  );
}
