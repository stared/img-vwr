import { useEffect, useRef, useState } from "react";

import type { SortKey } from "../../state/query";
import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import { useAppStore } from "../../state/store";

const SORT_LABELS: Record<SortKey, string> = {
  name: "name",
  modified: "modified",
  size: "size",
};

/**
 * Always-present query bar. Every chip is an explicit `key: value` clause of
 * the query — path (the scope), the filters, and the sort, which always
 * exists and is therefore always shown, Linear-style.
 */
export function FilterBar() {
  const folderPath = useAppStore((s) => s.folderPath);
  const query = useAppStore((s) => s.query);
  const findOpen = useAppStore((s) => s.findOpen);
  const setNameFilter = useAppStore((s) => s.setNameFilter);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);
  const clearFormatFilter = useAppStore((s) => s.clearFormatFilter);
  const sortBy = useAppStore((s) => s.sortBy);

  const [menuOpen, setMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameText = nameFilterText(query);
  const formats = activeFormats(query);
  const showFind = findOpen || nameText !== "";
  const sort = query.sort;

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  if (!folderPath) return null;

  // Value part of the path chip: enough of the tail to orient, not the whole path.
  const shortPath = folderPath.split("/").filter(Boolean).slice(-2).join("/") + "/";
  const closeMenu = () => setMenuOpen(false);
  const closeSortMenu = () => setSortMenuOpen(false);
  const formatLabels = formats
    .map((id) => FORMAT_GROUPS.find((g) => g.id === id)?.label ?? id)
    .join(", ");

  return (
    <div className="filterbar">
      <span className="chip chip-scope" title={folderPath}>
        <span className="chip-key">path:</span> {shortPath}
      </span>

      {showFind && (
        <span className="chip">
          <span className="chip-key">name:</span>
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

      {formats.length > 0 && (
        <button className="chip chip-removable" title="remove type filter" onClick={clearFormatFilter}>
          <span className="chip-key">type:</span> {formatLabels}
          <span className="chip-x">×</span>
        </button>
      )}

      <div className="filter-add">
        <button className="chip chip-add" title="add filter" onClick={() => setMenuOpen(!menuOpen)}>
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
            </div>
          </>
        )}
      </div>

      {/* Sort always exists — right-aligned, never removable. Its chip is the
          sort control: pick a key; picking the active key reverses direction. */}
      <div className="sort-control">
        <button
          className="chip chip-sort"
          title="change sort (picking the active key reverses it)"
          onClick={() => setSortMenuOpen(!sortMenuOpen)}
        >
          <span className="chip-key">sort:</span> {SORT_LABELS[sort.key]}{" "}
          {sort.dir === "asc" ? "↑" : "↓"}
        </button>
        {sortMenuOpen && (
          <>
            <div className="menu-backdrop" onClick={closeSortMenu} />
            <div className="filter-menu sort-menu">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <button
                  key={key}
                  onClick={() => {
                    sortBy(key);
                    closeSortMenu();
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
