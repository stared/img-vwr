import { useEffect, useRef, useState, type ReactNode } from "react";

import { executeCommand } from "../../registry/commands";
import { filterFieldsFor, getFilterField, type FilterField } from "../../registry/filters";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { getSort, sortsFor, type SortChipSegment, type SortDir } from "../../registry/sorts";
import { allSources } from "../../registry/sources";
import type { RangeOp, Sort } from "../../state/query";
import { activeFormats, formatGroupLabel, nameFilterText } from "../../state/query";
import {
  CAPTION_CYCLE,
  CAPTION_LABELS,
  CAPTION_NOTES,
  OVERLAY_CYCLE,
  OVERLAY_LABELS,
  OVERLAY_NOTES,
  useDevelopStore,
} from "../../state/develop";
import { sceneGapLabel, sliderFromTau, tauFromSlider } from "../../state/scenes";
import type { GalleryLayout, Scope } from "../../state/store";
import { useAppStore } from "../../state/store";
import { maxColumnsFor } from "../gallery/GalleryGrid";
import { ZoomBar } from "../viewer/ZoomBar";
import { FormatMenuItems } from "./filterMenus";
import { parseNumber, Slider } from "./Slider";

/**
 * Every sort choice the current scope offers, from the sort registry — each
 * provider contributes both directions, led by its default. A parameterized
 * sort whose parameter is unset contributes one row that collects it
 * (e.g. "closest to…" opens the phrase editor).
 */
type SortRow =
  | { kind: "sort"; sort: Sort; label: string; hint: string }
  | { kind: "collect"; providerId: string; label: string; hint: string };

function sortOptions(scope: Scope | null): SortRow[] {
  return sortsFor(scope).flatMap((provider): SortRow[] => {
    if (provider.param !== null && !provider.param.isSet()) {
      return [
        {
          kind: "collect",
          providerId: provider.id,
          label: provider.param.collectLabel,
          hint: provider.param.collectHint,
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

/** Renderings of the query result the view chip offers. */
const VIEW_OPTIONS: { layout: GalleryLayout; hint: string }[] = [
  { layout: "grid", hint: "thumbnails" },
  { layout: "mosaic", hint: "packed rows, no gaps" },
  { layout: "scenes", hint: "grouped into moments" },
  { layout: "timeline", hint: "by date" },
  { layout: "map", hint: "geolocated" },
  { layout: "darkroom", hint: "one large, strip below" },
];

/** The current view's knobs, at the bottom of the view chip's menu — the
 * one home for per-view rendering parameters. */
function ViewKnobs({ layout }: { layout: GalleryLayout }) {
  const gridColumns = useAppStore((s) => s.gridColumns);
  const setGridColumns = useAppStore((s) => s.setGridColumns);
  const sceneGapMin = useAppStore((s) => s.sceneGapMin);
  const setSceneGap = useAppStore((s) => s.setSceneGap);
  const contentWeight = useAppStore((s) => s.sceneContentWeight);
  const setContentWeight = useAppStore((s) => s.setSceneContentWeight);
  const rowPx = useAppStore((s) => s.mosaicRowPx);
  const setRowPx = useAppStore((s) => s.setMosaicRowPx);
  const packing = useAppStore((s) => s.mosaicPacking);
  const setPacking = useAppStore((s) => s.setMosaicPacking);
  const orientation = useAppStore((s) => s.timelineOrientation);
  const setTimelineOrientation = useAppStore((s) => s.setTimelineOrientation);
  const thumbPx = useAppStore((s) => s.timelineThumbPx);
  const setTimelineThumbPx = useAppStore((s) => s.setTimelineThumbPx);
  const caption = useDevelopStore((s) => s.caption);
  const setCaption = useDevelopStore((s) => s.setCaption);
  const overlay = useDevelopStore((s) => s.session?.overlay ?? "none");
  const setOverlay = useDevelopStore((s) => s.setOverlay);
  const gridlines = useDevelopStore((s) => s.gridlines);
  const toggleGridlines = useDevelopStore((s) => s.toggleGridlines);

  const columns = (
    <Slider
      label="per row"
      value={gridColumns}
      neutral={2}
      min={2}
      max={maxColumnsFor(window.innerWidth)}
      step={1}
      display={`${gridColumns}`}
      parse={parseNumber}
      ticks={[]}
      layout="inline"
      title="how many photos fill a row"
      onChange={setGridColumns}
    />
  );

  switch (layout) {
    case "grid":
      return <div className="menu-knobs">{columns}</div>;
    case "scenes":
      return (
        <div className="menu-knobs">
          {columns}
          <Slider
            label="scene break"
            value={sliderFromTau(sceneGapMin)}
            neutral={0}
            min={0}
            max={1}
            step={0.005}
            display={sceneGapLabel(sceneGapMin)}
            parse={(text) => {
              const minutes = parseNumber(text);
              return minutes === null ? null : sliderFromTau(minutes);
            }}
            ticks={[1, 5, 30, 60].map((minutes) => ({
              at: sliderFromTau(minutes),
              title: minutes < 60 ? `${minutes} min` : "an hour",
            }))}
            layout="inline"
            title="how long a pause splits scenes — log scale, 30 s to an hour"
            onChange={(x) => setSceneGap(tauFromSlider(x))}
          />
          <Slider
            label="content"
            value={contentWeight}
            neutral={0}
            min={0}
            max={1}
            step={0.01}
            display={`${Math.round(contentWeight * 100)}%`}
            parse={(text) => {
              const percent = parseNumber(text);
              return percent === null ? null : percent / 100;
            }}
            ticks={[{ at: 0.5, title: "the clock and the pictures, evenly" }]}
            layout="inline"
            title="how much the pictures outvote the clock at scene breaks"
            onChange={setContentWeight}
          />
        </div>
      );
    case "mosaic":
      return (
        <div className="menu-knobs">
          <Slider
            label="row height"
            value={rowPx}
            neutral={80}
            min={80}
            max={360}
            step={1}
            display={`${rowPx} px`}
            parse={parseNumber}
            ticks={[]}
            layout="inline"
            title="how tall the rows aim to be"
            onChange={setRowPx}
          />
          {(
            [
              { value: "order", label: "as sorted", hint: "rows vary a little in scale" },
              { value: "packed", label: "one scale", hint: "reordered locally to fit" },
            ] as const
          ).map((row) => (
            <button key={row.value} onClick={() => setPacking(row.value)}>
              <span>{row.label}</span>
              <span className="menu-hint">{row.hint}</span>
              <span className="menu-check">{packing === row.value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      );
    case "timeline":
      return (
        <div className="menu-knobs">
          {(["vertical", "horizontal"] as const).map((o) => (
            <button key={o} onClick={() => setTimelineOrientation(o)}>
              <span>{o}</span>
              <span className="menu-check">{orientation === o ? "✓" : ""}</span>
            </button>
          ))}
          <Slider
            label="size"
            value={thumbPx}
            neutral={80}
            min={80}
            max={400}
            step={1}
            display={`${thumbPx} px`}
            parse={parseNumber}
            ticks={[]}
            layout="inline"
            title="photo size — the time scale stays put"
            onChange={setTimelineThumbPx}
          />
        </div>
      );
    case "darkroom":
      return (
        <div className="menu-knobs">
          <span className="menu-section">caption</span>
          {CAPTION_CYCLE.map((mode) => (
            <button key={mode} title={CAPTION_NOTES[mode]} onClick={() => setCaption(mode)}>
              <span>{CAPTION_LABELS[mode]}</span>
              <span className="menu-check">{caption === mode ? "✓" : ""}</span>
            </button>
          ))}
          <span className="menu-section">overlay</span>
          {OVERLAY_CYCLE.map((mode) => (
            <button key={mode} title={OVERLAY_NOTES[mode]} onClick={() => setOverlay(mode)}>
              <span>{OVERLAY_LABELS[mode]}</span>
              <span className="menu-check">{overlay === mode ? "✓" : ""}</span>
            </button>
          ))}
          <button onClick={toggleGridlines}>
            <span>thirds guides</span>
            <span className="menu-check">{gridlines ? "✓" : ""}</span>
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** Right-side hint in the "+" menu, by field kind. */
function fieldHint(field: FilterField): string {
  switch (field.kind) {
    case "action":
      return "";
    case "menu":
      return field.hint;
    case "select":
    case "flags":
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

/** The scope is a clause too: click to change where the images come from. */
function ScopeChip({ scope }: { scope: Scope }) {
  const promptCommand = useAppStore((s) => s.promptCommand);
  const openFolder = useAppStore((s) => s.openFolder);
  const chipKey = scope.kind === "folder" ? "path" : scope.sourceId;
  const value =
    scope.kind === "folder"
      ? scope.path.split("/").filter(Boolean).slice(-2).join("/") +
        (scope.recursive ? "/**" : "/")
      : scope.label;
  return (
    <EditableChip
      chipKey={chipKey}
      value={value}
      title={scope.kind === "folder" ? scope.path : scope.arg}
      renderMenu={(close) => (
        <>
          {scope.kind === "folder" && (
            <button
              onClick={() => {
                void openFolder(scope.path, !scope.recursive);
                close();
              }}
            >
              Include subfolders <span className="menu-hint">**</span>
              <span className="menu-check">{scope.recursive ? "✓" : ""}</span>
            </button>
          )}
          <button
            onClick={() => {
              executeCommand("folder.open", { store: useAppStore });
              close();
            }}
          >
            <span>Open Folder…</span>
            <span className="menu-key">
              {chordsForCommand("folder.open").map(formatChord)[0]}
            </span>
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
      <button
        className="chip chip-add"
        title="add filter — F finds by name"
        onClick={() => (open ? close() : setOpen(true))}
      >
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
  /** Provider id whose parameter is being collected in the chip right now. */
  const [collecting, setCollecting] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingSeg !== null) editRef.current?.focus();
  }, [editingSeg]);

  const activeProvider = getSort(sort.key);
  // While collecting, the chip shows the PENDING sort's segments instead.
  const collectingProvider = collecting === null ? undefined : getSort(collecting);
  const provider = collectingProvider ?? activeProvider;
  const segments: SortChipSegment[] =
    provider === undefined
      ? [{ kind: "text", text: sort.key }]
      : provider.param === null
        ? [{ kind: "text", text: provider.label }]
        : provider.param.segments();

  const cancelCollect = () => {
    setCollecting(null);
    setEditingSeg(null);
  };
  const closeAll = () => {
    setSortMenuOpen(false);
    setOpenSeg(null);
  };
  const toggleSortMenu = () => {
    cancelCollect();
    setOpenSeg(null);
    setSortMenuOpen(!sortMenuOpen);
  };
  const startCollect = (providerId: string) => {
    const pending = getSort(providerId);
    if (pending === undefined || pending.param === null) return;
    const editIndex = pending.param.segments().findIndex((s) => s.kind === "edit");
    setCollecting(providerId);
    setEditingSeg(editIndex >= 0 ? editIndex : null);
    setEditText("");
    closeAll();
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
                    cancelCollect();
                  }
                  if (e.key === "Escape") {
                    cancelCollect();
                    e.stopPropagation();
                  }
                }}
                // While collecting, the input persists so the model can be
                // picked first; the backdrop handles clicks elsewhere.
                onBlur={() => {
                  if (collecting === null) setEditingSeg(null);
                }}
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
        {collecting === null && (
          <button
            className="chip-seg"
            title="flip direction"
            onClick={() => setSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}
          >
            {sort.dir === "asc" ? "↑" : "↓"}
          </button>
        )}
        {collecting === null && provider !== undefined && provider.param !== null && (
          <button className="chip-x" title="remove this sort" onClick={provider.param.clear}>
            ×
          </button>
        )}
      </span>

      {collecting !== null && <div className="menu-backdrop" onClick={cancelCollect} />}

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
                    key={`collect-${row.providerId}`}
                    onClick={() => startCollect(row.providerId)}
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

  const formatLabels = formats.map(formatGroupLabel).join(", ");

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

      <AddFilterMenu scope={scope} />

      {/* The right cluster: how the results render and in what order. */}
      <div className="filterbar-right">
      <EditableChip
        chipKey="view"
        value={galleryLayout}
        title="change how the results render"
        renderMenu={(close) => (
          <>
            {VIEW_OPTIONS.map(({ layout, hint }) => {
              const chord = chordsForCommand(`view.${layout}`).map(formatChord)[0];
              return (
                <button
                  key={layout}
                  onClick={() => {
                    setGalleryLayout(layout);
                    close();
                  }}
                >
                  <span>{layout}</span>
                  <span className="menu-hint">{hint}</span>
                  {chord !== undefined && <span className="menu-key">{chord}</span>}
                  <span className="menu-check">{galleryLayout === layout ? "✓" : ""}</span>
                </button>
              );
            })}
            <ViewKnobs layout={galleryLayout} />
          </>
        )}
      />

      <SortChip scope={scope} sort={query.sort} />

      {galleryLayout === "darkroom" && <ZoomBar />}
      </div>
    </div>
  );
}
