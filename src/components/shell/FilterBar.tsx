import { useEffect, useRef, useState, type ReactNode } from "react";

import { executeCommand } from "../../registry/commands";
import { allSources } from "../../registry/sources";
import type { RangeField, Sort, SortKey } from "../../state/query";
import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import type { Scope } from "../../state/store";
import { useAppStore } from "../../state/store";
import { AspectMenuItems, CameraMenuItems, FormatMenuItems, RangeMenuForm } from "./filterMenus";

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

const RANGE_FIELDS: { field: RangeField; label: string }[] = [
  { field: "taken", label: "taken" },
  { field: "modified", label: "modified" },
  { field: "size", label: "size" },
  { field: "edge", label: "longest edge" },
];

/**
 * A chip whose body opens an editor dropdown; only the × removes the clause.
 */
function EditableChip({
  chipKey,
  value,
  title,
  onRemove,
  renderMenu,
}: {
  chipKey: string;
  value: string;
  title?: string;
  onRemove?: () => void;
  renderMenu: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="chip-wrap">
      <span className={`chip chip-edit${onRemove ? " chip-removable" : ""}`}>
        <button
          className="chip-body"
          title={title ?? `edit ${chipKey} filter`}
          onClick={() => setOpen(!open)}
        >
          <span className="chip-key">{chipKey}:</span> {value}
        </button>
        {onRemove && (
          <button className="chip-x" title={`remove ${chipKey} filter`} onClick={onRemove}>
            ×
          </button>
        )}
      </span>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="filter-menu">{renderMenu(close)}</div>
        </>
      )}
    </div>
  );
}

/** The scope is a clause too: click to change where the images come from. */
function ScopeChip({ scope }: { scope: Scope }) {
  const promptCommand = useAppStore((s) => s.promptCommand);
  const chipKey = scope.kind === "folder" ? "path" : scope.sourceId;
  const value =
    scope.kind === "folder"
      ? scope.path.split("/").filter(Boolean).slice(-2).join("/") + "/"
      : scope.label;
  return (
    <EditableChip
      chipKey={chipKey}
      value={value}
      title={scope.kind === "folder" ? scope.path : scope.arg}
      renderMenu={(close) => (
        <>
          <button
            onClick={() => {
              executeCommand("folder.open", { store: useAppStore });
              close();
            }}
          >
            Open Folder…
          </button>
          {allSources().map((source) => (
            <button
              key={source.id}
              onClick={() => {
                promptCommand(`source.${source.id}`);
                close();
              }}
            >
              {source.title}
            </button>
          ))}
        </>
      )}
    />
  );
}

type AddSub = null | "format" | "camera" | "aspect" | RangeField;

/** The "+" menu: every filterable field, one level deep. */
function AddFilterMenu() {
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<AddSub>(null);
  const close = () => {
    setOpen(false);
    setSub(null);
  };

  const subLabel =
    sub === "format" || sub === "camera" || sub === "aspect"
      ? sub
      : RANGE_FIELDS.find((r) => r.field === sub)?.label;

  return (
    <div className="filter-add">
      <button className="chip chip-add" title="add filter" onClick={() => (open ? close() : setOpen(true))}>
        +
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="filter-menu">
            {sub === null ? (
              <>
                <span className="menu-section">Filter by</span>
                <button
                  onClick={() => {
                    setFindOpen(true);
                    close();
                  }}
                >
                  name…
                </button>
                <button onClick={() => setSub("format")}>
                  format <span className="menu-hint">›</span>
                </button>
                <button onClick={() => setSub("camera")}>
                  camera <span className="menu-hint">›</span>
                </button>
                <button onClick={() => setSub("aspect")}>
                  aspect <span className="menu-hint">›</span>
                </button>
                {RANGE_FIELDS.map(({ field, label }) => (
                  <button key={field} onClick={() => setSub(field)}>
                    {label} <span className="menu-hint">≤ = ≥</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button className="menu-back" onClick={() => setSub(null)}>
                  ‹ {subLabel}
                </button>
                {sub === "format" && <FormatMenuItems />}
                {sub === "camera" && <CameraMenuItems close={close} />}
                {sub === "aspect" && <AspectMenuItems close={close} />}
                {sub !== "format" && sub !== "camera" && sub !== "aspect" && (
                  <RangeMenuForm field={sub} close={close} />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Always-present query bar. Every chip is an explicit `key: value` clause of
 * the query — the scope, the filters, the view and the sort. Clicking a chip
 * edits that clause; the × removes it.
 */
export function FilterBar() {
  const scope = useAppStore((s) => s.scope);
  const query = useAppStore((s) => s.query);
  const findOpen = useAppStore((s) => s.findOpen);
  const setNameFilter = useAppStore((s) => s.setNameFilter);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const clearFormatFilter = useAppStore((s) => s.clearFormatFilter);
  const toggleCameraFilter = useAppStore((s) => s.toggleCameraFilter);
  const toggleAspectFilter = useAppStore((s) => s.toggleAspectFilter);
  const toggleRangeFilter = useAppStore((s) => s.toggleRangeFilter);
  const setSort = useAppStore((s) => s.setSort);
  const galleryLayout = useAppStore((s) => s.galleryLayout);
  const setGalleryLayout = useAppStore((s) => s.setGalleryLayout);

  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameText = nameFilterText(query);
  const formats = activeFormats(query);
  const showFind = findOpen || nameText !== "";
  const sort = query.sort;

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  if (!scope) return null;

  const closeSortMenu = () => setSortMenuOpen(false);
  const formatLabels = formats
    .map((id) => FORMAT_GROUPS.find((g) => g.id === id)?.label ?? id)
    .join(", ");

  return (
    <div className="filterbar">
      <ScopeChip scope={scope} />

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
        <EditableChip
          chipKey="type"
          value={formatLabels}
          onRemove={clearFormatFilter}
          renderMenu={() => <FormatMenuItems />}
        />
      )}

      {query.filters.map((filter) => {
        switch (filter.kind) {
          case "camera":
            return (
              <EditableChip
                key="camera"
                chipKey="camera"
                value={filter.camera}
                onRemove={() => toggleCameraFilter(filter.camera)}
                renderMenu={(close) => <CameraMenuItems close={close} />}
              />
            );
          case "aspect":
            return (
              <EditableChip
                key="aspect"
                chipKey="aspect"
                value={filter.aspect}
                onRemove={() => toggleAspectFilter(filter.aspect)}
                renderMenu={(close) => <AspectMenuItems close={close} />}
              />
            );
          case "range":
            return (
              <EditableChip
                key={`range-${filter.field}`}
                chipKey={filter.field}
                value={filter.label}
                onRemove={() =>
                  toggleRangeFilter(filter.field, filter.from, filter.to, filter.label)
                }
                renderMenu={(close) => <RangeMenuForm field={filter.field} close={close} />}
              />
            );
          default:
            return null; // name and format have dedicated chips above
        }
      })}

      <AddFilterMenu />

      {/* View is part of how the query renders — grid, or a map of the
          geolocated results. Clicking flips between the two. */}
      <button
        className="chip chip-view"
        title={galleryLayout === "grid" ? "show on a map" : "back to the grid"}
        onClick={() => setGalleryLayout(galleryLayout === "grid" ? "map" : "grid")}
      >
        <span className="chip-key">view:</span> {galleryLayout}
      </button>

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
