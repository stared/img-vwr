import { useEffect, useRef, useState, type ReactNode } from "react";

import { executeCommand } from "../../registry/commands";
import { similarTo } from "../../similarity";
import { filterFieldsFor, getFilterField, type FilterField } from "../../registry/filters";
import { getSort, sortsFor, type SortChipSegment, type SortDir } from "../../registry/sorts";
import { allSources } from "../../registry/sources";
import type { RangeOp, Sort } from "../../state/query";
import { activeFormats, FORMAT_GROUPS, nameFilterText } from "../../state/query";
import type { Scope } from "../../state/store";
import { useAppStore } from "../../state/store";
import { FormatMenuItems } from "./filterMenus";

/**
 * Every sort choice the current scope offers, from the sort registry — each
 * provider contributes both directions, led by its default. A parameterized
 * sort whose parameter is unset contributes one row that collects it
 * (e.g. "closest to…" opens the phrase editor).
 */
type SortRow =
  | { kind: "sort"; sort: Sort; label: string; hint: string }
  | { kind: "collect"; label: string; hint: string; collect: () => void };

function sortOptions(scope: Scope | null): SortRow[] {
  return sortsFor(scope).flatMap((provider): SortRow[] => {
    if (provider.param !== null && !provider.param.isSet()) {
      return [
        {
          kind: "collect",
          label: provider.param.collectLabel,
          hint: provider.param.collectHint,
          collect: provider.param.collect,
        },
      ];
    }
    const dirs: SortDir[] =
      provider.defaultDir === "asc" ? ["asc", "desc"] : ["desc", "asc"];
    return dirs.map((dir) => ({
      kind: "sort",
      sort: { key: provider.id, dir },
      label: provider.label,
      hint: provider.hints[dir],
    }));
  });
}

const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

/** Right-side hint in the "+" menu, by field kind. */
function fieldHint(field: FilterField): string {
  switch (field.kind) {
    case "action":
      return "";
    case "menu":
      return field.hint;
    case "select":
      return "›";
    case "range":
      return field.spec.ops.map((op) => OP_SYMBOL[op]).join(" ");
  }
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

/**
 * Transient editor for the "closest to" phrase — visible only while typing;
 * the committed clause lives in the sort chip (`sort: closest to "…" with
 * <model> ↓`), never as a second chip.
 */
function ClosestChip() {
  const closestOpen = useAppStore((s) => s.closestOpen);
  const setClosestOpen = useAppStore((s) => s.setClosestOpen);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!closestOpen) return;
    // Prefill with the current phrase when editing an existing anchor.
    const anchor = useAppStore.getState().similarity?.anchor;
    setText(anchor?.kind === "text" ? anchor.query : "");
    inputRef.current?.focus();
  }, [closestOpen]);

  if (!closestOpen) return null;
  return (
    <span className="chip">
      <span className="chip-key">closest to:</span>
      <input
        ref={inputRef}
        value={text}
        placeholder="describe it…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            const query = text.trim();
            void similarTo({ kind: "text", query }, `"${query}"`);
            setClosestOpen(false);
          }
          if (e.key === "Escape") {
            setClosestOpen(false);
            e.stopPropagation();
          }
        }}
        onBlur={() => setClosestOpen(false)}
      />
    </span>
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
  const found = subId === null ? undefined : fields.find((f) => f.id === subId);
  const sub = found !== undefined && found.kind !== "action" ? found : undefined;

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
                      if (field.kind === "action") {
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
                <sub.Menu close={close} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The sort chip, right-aligned and always present. Every token is its own
 * click target: inert words (and `sort:`) open the sort menu, an `edit`
 * token becomes an inline input in place, a `menu` token drops its own
 * dropdown (the model picker), and the arrow flips direction on any sort.
 * Parameterized sorts get an × that drops the parameter.
 */
function SortChip({ scope, sort }: { scope: Scope; sort: Sort }) {
  const setSort = useAppStore((s) => s.setSort);
  // Parameterized segments read app state via getState() (the anchor, the
  // model lifecycle); subscribing keeps the chip text live without the
  // registry knowing which state that is.
  useAppStore((s) => s.similarity);
  useAppStore((s) => s.embedModels);
  useAppStore((s) => s.embedStatus);

  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [openSeg, setOpenSeg] = useState<number | null>(null);
  const [editingSeg, setEditingSeg] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSeg !== null) editRef.current?.focus();
  }, [editingSeg]);

  const provider = getSort(sort.key);
  const segments: SortChipSegment[] =
    provider === undefined
      ? [{ kind: "text", text: sort.key }]
      : provider.param === null
        ? [{ kind: "text", text: provider.label }]
        : provider.param.segments();

  const closeAll = () => {
    setSortMenuOpen(false);
    setOpenSeg(null);
  };
  const toggleSortMenu = () => {
    setOpenSeg(null);
    setSortMenuOpen(!sortMenuOpen);
  };

  const openSegment = openSeg === null ? undefined : segments[openSeg];
  const SegMenu = openSegment?.kind === "menu" ? openSegment.Menu : undefined;

  return (
    <div className="sort-control">
      <span className={`chip chip-sort chip-edit${provider?.param ? " chip-removable" : ""}`}>
        <button className="chip-seg" title="change sort" onClick={toggleSortMenu}>
          <span className="chip-key">sort:</span>
        </button>
        {segments.map((seg, i) => {
          if (seg.kind === "edit" && editingSeg === i) {
            return (
              <input
                key={i}
                ref={editRef}
                value={editText}
                placeholder={seg.placeholder}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editText.trim()) {
                    seg.commit(editText);
                    setEditingSeg(null);
                  }
                  if (e.key === "Escape") {
                    setEditingSeg(null);
                    e.stopPropagation();
                  }
                }}
                onBlur={() => setEditingSeg(null)}
              />
            );
          }
          const onClick =
            seg.kind === "text"
              ? toggleSortMenu
              : seg.kind === "edit"
                ? () => {
                    setEditText(seg.prefill);
                    setEditingSeg(i);
                    closeAll();
                  }
                : () => {
                    setSortMenuOpen(false);
                    setOpenSeg(openSeg === i ? null : i);
                  };
          return (
            <button
              key={i}
              className={`chip-seg${seg.kind === "text" ? "" : " chip-seg-live"}`}
              title={
                seg.kind === "text"
                  ? "change sort"
                  : seg.kind === "edit"
                    ? "click to edit"
                    : "click to change"
              }
              onClick={onClick}
            >
              {seg.text}
            </button>
          );
        })}
        <button
          className="chip-seg"
          title="flip direction"
          onClick={() => setSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}
        >
          {sort.dir === "asc" ? "↑" : "↓"}
        </button>
        {provider !== undefined && provider.param !== null && (
          <button className="chip-x" title="remove this sort" onClick={provider.param.clear}>
            ×
          </button>
        )}
      </span>

      {SegMenu !== undefined && (
        <>
          <div className="menu-backdrop" onClick={closeAll} />
          <div className="filter-menu sort-menu">
            <SegMenu close={closeAll} />
          </div>
        </>
      )}

      {sortMenuOpen && (
        <>
          <div className="menu-backdrop" onClick={closeAll} />
          <div className="filter-menu sort-menu">
            {sortOptions(scope).map((row) => {
              if (row.kind === "collect") {
                return (
                  <button
                    key={`collect-${row.label}`}
                    onClick={() => {
                      row.collect();
                      closeAll();
                    }}
                  >
                    <span>{row.label}</span>
                    <span className="menu-hint">{row.hint}</span>
                    <span className="menu-check"></span>
                  </button>
                );
              }
              const active = row.sort.key === sort.key && row.sort.dir === sort.dir;
              return (
                <button
                  key={`${row.sort.key}-${row.sort.dir}`}
                  onClick={() => {
                    setSort(row.sort);
                    closeAll();
                  }}
                >
                  <span>
                    {row.label} {row.sort.dir === "asc" ? "↑" : "↓"}
                  </span>
                  <span className="menu-hint">{row.hint}</span>
                  <span className="menu-check">{active ? "✓" : ""}</span>
                </button>
              );
            })}
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
  const galleryLayout = useAppStore((s) => s.galleryLayout);
  const setGalleryLayout = useAppStore((s) => s.setGalleryLayout);

  const inputRef = useRef<HTMLInputElement>(null);

  const nameText = nameFilterText(query);
  const formats = activeFormats(query);
  const showFind = findOpen || nameText !== "";

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  if (!scope) return null;

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
        const field = getFilterField(filter.field);
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
            renderMenu={(close) =>
              // A clause whose field is gone (uninstalled plugin) has no menu.
              field !== undefined && field.kind !== "action" ? <field.Menu close={close} /> : null
            }
          />
        );
      })}

      <ClosestChip />

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

      <SortChip scope={scope} sort={query.sort} />
    </div>
  );
}
