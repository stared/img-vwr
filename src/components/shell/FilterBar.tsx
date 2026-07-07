import { useEffect, useRef, useState } from "react";

import type { Sort, SortKey } from "../../state/query";
import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import { useAppStore } from "../../state/store";

const SORT_LABELS: Record<SortKey, string> = {
  name: "name",
  modified: "modified",
  size: "size",
};

/** Every complete sort choice, each key led by its most useful direction. */
const SORT_OPTIONS: { sort: Sort; hint: string }[] = [
  { sort: { key: "name", dir: "asc" }, hint: "A→Z" },
  { sort: { key: "name", dir: "desc" }, hint: "Z→A" },
  { sort: { key: "modified", dir: "desc" }, hint: "newest" },
  { sort: { key: "modified", dir: "asc" }, hint: "oldest" },
  { sort: { key: "size", dir: "desc" }, hint: "largest" },
  { sort: { key: "size", dir: "asc" }, hint: "smallest" },
];

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
  const toggleCameraFilter = useAppStore((s) => s.toggleCameraFilter);
  const toggleAspectFilter = useAppStore((s) => s.toggleAspectFilter);
  const toggleRangeFilter = useAppStore((s) => s.toggleRangeFilter);
  const setSort = useAppStore((s) => s.setSort);

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

      {/* Clauses added by clicking stats buckets; clicking × (or the bucket again) removes them. */}
      {query.filters.map((filter) => {
        switch (filter.kind) {
          case "camera":
            return (
              <button
                key="camera"
                className="chip chip-removable"
                title="remove camera filter"
                onClick={() => toggleCameraFilter(filter.camera)}
              >
                <span className="chip-key">camera:</span> {filter.camera}
                <span className="chip-x">×</span>
              </button>
            );
          case "aspect":
            return (
              <button
                key="aspect"
                className="chip chip-removable"
                title="remove aspect filter"
                onClick={() => toggleAspectFilter(filter.aspect)}
              >
                <span className="chip-key">aspect:</span> {filter.aspect}
                <span className="chip-x">×</span>
              </button>
            );
          case "range":
            return (
              <button
                key={`range-${filter.field}`}
                className="chip chip-removable"
                title={`remove ${filter.field} filter`}
                onClick={() => toggleRangeFilter(filter.field, filter.from, filter.to, filter.label)}
              >
                <span className="chip-key">{filter.field}:</span> {filter.label}
                <span className="chip-x">×</span>
              </button>
            );
          default:
            return null; // name and format have dedicated chips above
        }
      })}

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
          sort control: every menu row is a complete key+direction choice. */}
      <div className="sort-control">
        <button
          className="chip chip-sort"
          title="change sort"
          onClick={() => setSortMenuOpen(!sortMenuOpen)}
        >
          <span className="chip-key">sort:</span> {SORT_LABELS[sort.key]}{" "}
          {sort.dir === "asc" ? "↑" : "↓"}
        </button>
        {sortMenuOpen && (
          <>
            <div className="menu-backdrop" onClick={closeSortMenu} />
            <div className="filter-menu sort-menu">
              {SORT_OPTIONS.map(({ sort: option, hint }) => {
                const active = option.key === sort.key && option.dir === sort.dir;
                return (
                  <button
                    key={`${option.key}-${option.dir}`}
                    onClick={() => {
                      setSort(option);
                      closeSortMenu();
                    }}
                  >
                    <span>
                      {SORT_LABELS[option.key]} {option.dir === "asc" ? "↑" : "↓"}
                    </span>
                    <span className="menu-hint">{hint}</span>
                    <span className="menu-check">{active ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
