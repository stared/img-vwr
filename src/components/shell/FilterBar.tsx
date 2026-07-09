import { useEffect, useRef, useState, type ReactNode } from "react";

import { executeCommand } from "../../registry/commands";
import { filterFieldsFor, getFilterField, type FilterField } from "../../registry/filters";
import { getSort, sortsFor, type SortDir } from "../../registry/sorts";
import { allSources } from "../../registry/sources";
import type { RangeOp, Sort } from "../../state/query";
import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import type { Scope } from "../../state/store";
import { useAppStore } from "../../state/store";
import { FormatMenuItems } from "./filterMenus";

/**
 * Every complete sort choice the current scope offers, from the sort
 * registry — each provider contributes both directions, led by its default.
 */
function sortOptions(scope: Scope | null): { sort: Sort; label: string; hint: string }[] {
  return sortsFor(scope).flatMap((provider) => {
    const dirs: SortDir[] =
      provider.defaultDir === "asc" ? ["asc", "desc"] : ["desc", "asc"];
    return dirs.map((dir) => ({
      sort: { key: provider.id, dir },
      label: provider.label,
      hint: provider.hints?.[dir] ?? "",
    }));
  });
}

const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

/** Right-side hint in the "+" menu: the field's operators, or a submenu mark. */
function fieldHint(field: FilterField): string {
  if (field.range) return field.range.ops.map((op) => OP_SYMBOL[op]).join(" ");
  return field.pick ? "" : "›";
}

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

/** The "+" menu: every registered filter field the scope offers, one level deep. */
function AddFilterMenu({ scope }: { scope: Scope }) {
  const [open, setOpen] = useState(false);
  const [subId, setSubId] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setSubId(null);
  };

  const fields = filterFieldsFor(scope);
  const sub = subId === null ? undefined : fields.find((f) => f.id === subId);
  const SubMenu = sub?.Menu;

  return (
    <div className="filter-add">
      <button className="chip chip-add" title="add filter" onClick={() => (open ? close() : setOpen(true))}>
        +
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="filter-menu">
            {sub === undefined ? (
              <>
                <span className="menu-section">Filter by</span>
                {fields.map((field) => (
                  <button
                    key={field.id}
                    onClick={() => {
                      if (field.pick) {
                        field.pick();
                        close();
                      } else {
                        setSubId(field.id);
                      }
                    }}
                  >
                    {field.label} <span className="menu-hint">{fieldHint(field)}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button className="menu-back" onClick={() => setSubId(null)}>
                  ‹ {sub.label}
                </button>
                {SubMenu && <SubMenu close={close} />}
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
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);
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
        // Field-keyed clauses: the chip's edit menu is the field's own menu.
        if (filter.kind !== "select" && filter.kind !== "range") {
          return null; // name and format have dedicated chips above
        }
        const FieldMenu = getFilterField(filter.field)?.Menu;
        return (
          <EditableChip
            key={`${filter.kind}-${filter.field}`}
            chipKey={filter.field}
            value={filter.kind === "select" ? filter.value : filter.label}
            onRemove={() =>
              filter.kind === "select"
                ? toggleSelectFilter(filter.field, filter.value)
                : toggleRangeFilter(filter.field, filter.from, filter.to, filter.label)
            }
            renderMenu={(close) => (FieldMenu ? <FieldMenu close={close} /> : null)}
          />
        );
      })}

      <AddFilterMenu scope={scope} />

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
          <span className="chip-key">sort:</span> {getSort(sort.key)?.label ?? sort.key}{" "}
          {sort.dir === "asc" ? "↑" : "↓"}
        </button>
        {sortMenuOpen && (
          <>
            <div className="menu-backdrop" onClick={closeSortMenu} />
            <div className="filter-menu sort-menu">
              {sortOptions(scope).map(({ sort: option, label, hint }) => {
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
                      {label} {option.dir === "asc" ? "↑" : "↓"}
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
