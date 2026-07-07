import { useEffect, useRef, useState } from "react";

import type { SortKey } from "../../state/query";
import { activeFormats, defaultQuery, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import { useAppStore } from "../../state/store";

const SORT_LABELS: Record<SortKey, string> = {
  name: "name",
  modified: "modified",
  size: "size",
};

/**
 * Always-present query bar, Linear-style: the folder path is the first
 * (scope) chip, active filters and sort follow as chips, and "+" adds
 * more as you go.
 */
export function FilterBar() {
  const folderPath = useAppStore((s) => s.folderPath);
  const query = useAppStore((s) => s.query);
  const findOpen = useAppStore((s) => s.findOpen);
  const setNameFilter = useAppStore((s) => s.setNameFilter);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);
  const sortBy = useAppStore((s) => s.sortBy);
  const resetSort = useAppStore((s) => s.resetSort);

  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameText = nameFilterText(query);
  const formats = activeFormats(query);
  const showFind = findOpen || nameText !== "";
  const sort = query.sort;
  const sortIsDefault = sort.key === defaultQuery.sort.key && sort.dir === defaultQuery.sort.dir;

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  if (!folderPath) return null;

  const folderName = folderPath.split("/").filter(Boolean).pop() ?? folderPath;
  const closeMenu = () => setMenuOpen(false);

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

      {!sortIsDefault && (
        <button
          className="chip chip-removable"
          title="click to reverse, × resets to name ↑"
          onClick={() => sortBy(sort.key)}
        >
          {SORT_LABELS[sort.key]} {sort.dir === "asc" ? "↑" : "↓"}
          <span
            className="chip-x"
            onClick={(e) => {
              e.stopPropagation();
              resetSort();
            }}
          >
            ×
          </span>
        </button>
      )}

      <div className="filter-add">
        <button
          className="chip chip-add"
          title="add filter or sort"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          +
        </button>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={closeMenu} />
            <div className="filter-menu">
              <span className="menu-section">Filter</span>
              <button
                onClick={() => {
                  setFindOpen(true);
                  closeMenu();
                }}
              >
                name…
              </button>
              {FORMAT_GROUPS.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    toggleFormatFilter(g.id);
                    closeMenu();
                  }}
                >
                  {g.label}
                  {formats.includes(g.id) && <span className="menu-check">✓</span>}
                </button>
              ))}
              <span className="menu-section">Sort</span>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <button
                  key={key}
                  onClick={() => {
                    sortBy(key);
                    closeMenu();
                  }}
                >
                  {SORT_LABELS[key]}
                  {sort.key === key && (
                    <span className="menu-check">{sort.dir === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
