import { CAPTION_CYCLE, useDevelopStore, type CaptionMode } from "./develop";
import { defaultQuery, usesScores, type Filter, type Query, type Sort } from "./query";
import type { StackLead } from "./stacks";
import {
  useAppStore,
  type GalleryLayout,
  type MosaicPacking,
  type Scope,
  type TimelineOrientation,
} from "./store";

/**
 * The sitting, remembered: reopening the app puts you back where you were —
 * the same folder, the same view, the same filters — instead of an empty
 * pane asking you to find your own work again.
 *
 * What is saved is the *setup*, not the state: which folder, which layout,
 * which filters and sort, which panel — the choices that describe how you
 * work. What the folder contains is re-scanned fresh, selection starts
 * clear, and anything transient (a similarity sort whose scores lived in
 * memory) falls back to its default rather than being half-restored.
 */

const KEY = "imgvwr.session.v1";

interface SavedSession {
  scope: Scope | null;
  galleryLayout: GalleryLayout;
  query: Query;
  stacking: boolean;
  stackLead: StackLead;
  gridColumns: number;
  timelineOrientation: TimelineOrientation;
  timelineThumbPx: number;
  mosaicRowPx: number;
  mosaicPacking: MosaicPacking;
  statsVisible: boolean;
  sidebarVisible: boolean;
  activePanelId: string;
  sceneGapMin: number;
  sceneContentWeight: number;
  develop: {
    folded: Record<string, boolean>;
    caption: CaptionMode;
    showDeviation: boolean;
    gridlines: boolean;
  };
}

function snapshot(): SavedSession {
  const s = useAppStore.getState();
  const d = useDevelopStore.getState();
  return {
    scope: s.scope,
    galleryLayout: s.galleryLayout,
    // A scores-backed sort ("similar to …") reads a model run that died with
    // the window; saving it would restore a sort with nothing to sort by.
    query: usesScores(s.query) ? { ...s.query, sort: defaultQuery.sort } : s.query,
    stacking: s.stacking,
    stackLead: s.stackLead,
    gridColumns: s.gridColumns,
    timelineOrientation: s.timelineOrientation,
    timelineThumbPx: s.timelineThumbPx,
    mosaicRowPx: s.mosaicRowPx,
    mosaicPacking: s.mosaicPacking,
    statsVisible: s.statsVisible,
    sidebarVisible: s.sidebarVisible,
    activePanelId: s.activePanelId,
    sceneGapMin: s.sceneGapMin,
    sceneContentWeight: s.sceneContentWeight,
    develop: {
      folded: d.folded,
      caption: d.caption,
      showDeviation: d.showDeviation,
      gridlines: d.gridlines,
    },
  };
}

/* Reading back: the stored JSON is last launch's word, not this build's —
 * fields may be missing, enums may have been renamed. Each guard admits a
 * value only in this build's terms, and anything that fails simply keeps
 * its default: a stale session degrades to a fresh start, never a crash. */

const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T =>
  isString(v) && (all as readonly string[]).includes(v);

const LAYOUTS: readonly GalleryLayout[] = [
  "grid",
  "mosaic",
  "timeline",
  "map",
  "darkroom",
  "scenes",
];

function readScope(v: unknown): Scope | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "folder" && isString(o.path) && isBool(o.recursive)) {
    return { kind: "folder", path: o.path, recursive: o.recursive };
  }
  if (
    o.kind === "source" &&
    isString(o.sourceId) &&
    isString(o.arg) &&
    isString(o.label)
  ) {
    return { kind: "source", sourceId: o.sourceId, arg: o.arg, label: o.label };
  }
  return null;
}

function readFilter(v: unknown): Filter | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "format" && Array.isArray(o.formats) && o.formats.every(isString)) {
    return { kind: "format", formats: o.formats };
  }
  if (o.kind === "name" && isString(o.substring)) {
    return { kind: "name", substring: o.substring };
  }
  if (o.kind === "select" && isString(o.field) && isString(o.value)) {
    return { kind: "select", field: o.field, value: o.value };
  }
  if (
    o.kind === "range" &&
    isString(o.field) &&
    isNum(o.from) &&
    isNum(o.to) &&
    isString(o.label)
  ) {
    return { kind: "range", field: o.field, from: o.from, to: o.to, label: o.label };
  }
  return null;
}

function readQuery(v: unknown): Query {
  if (typeof v !== "object" || v === null) return defaultQuery;
  const o = v as Record<string, unknown>;
  const sortRaw = o.sort as Record<string, unknown> | undefined;
  const sort: Sort =
    sortRaw && isString(sortRaw.key) && oneOf(sortRaw.dir, ["asc", "desc"] as const)
      ? { key: sortRaw.key, dir: sortRaw.dir }
      : defaultQuery.sort;
  const filters = Array.isArray(o.filters)
    ? o.filters.map(readFilter).filter((f): f is Filter => f !== null)
    : [];
  return { filters, sort };
}

/**
 * Put last launch's setup back, then reopen its scope. Returns whether a
 * scope was reopened, so the caller knows the start folder is spoken for.
 */
export function restoreSession(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;

  const app = useAppStore.getState();
  useAppStore.setState({
    galleryLayout: oneOf(o.galleryLayout, LAYOUTS) ? o.galleryLayout : app.galleryLayout,
    query: readQuery(o.query),
    stacking: isBool(o.stacking) ? o.stacking : app.stacking,
    stackLead: oneOf(o.stackLead, ["jpg", "raw"] as const) ? o.stackLead : app.stackLead,
    gridColumns: isNum(o.gridColumns) ? o.gridColumns : app.gridColumns,
    timelineOrientation: oneOf(o.timelineOrientation, ["vertical", "horizontal"] as const)
      ? o.timelineOrientation
      : app.timelineOrientation,
    timelineThumbPx: isNum(o.timelineThumbPx) ? o.timelineThumbPx : app.timelineThumbPx,
    mosaicRowPx: isNum(o.mosaicRowPx) ? o.mosaicRowPx : app.mosaicRowPx,
    mosaicPacking: oneOf(o.mosaicPacking, ["order", "packed"] as const)
      ? o.mosaicPacking
      : app.mosaicPacking,
    statsVisible: isBool(o.statsVisible) ? o.statsVisible : app.statsVisible,
    sidebarVisible: isBool(o.sidebarVisible) ? o.sidebarVisible : app.sidebarVisible,
    activePanelId: isString(o.activePanelId) ? o.activePanelId : app.activePanelId,
    sceneGapMin: isNum(o.sceneGapMin) ? o.sceneGapMin : app.sceneGapMin,
    sceneContentWeight: isNum(o.sceneContentWeight)
      ? o.sceneContentWeight
      : app.sceneContentWeight,
  });

  const dev = (typeof o.develop === "object" && o.develop !== null
    ? o.develop
    : {}) as Record<string, unknown>;
  const d = useDevelopStore.getState();
  useDevelopStore.setState({
    folded:
      typeof dev.folded === "object" && dev.folded !== null
        ? Object.fromEntries(
            Object.entries(dev.folded as Record<string, unknown>).filter(
              (pair): pair is [string, boolean] => isBool(pair[1]),
            ),
          )
        : d.folded,
    caption: oneOf(dev.caption, CAPTION_CYCLE) ? dev.caption : d.caption,
    showDeviation: isBool(dev.showDeviation) ? dev.showDeviation : d.showDeviation,
    gridlines: isBool(dev.gridlines) ? dev.gridlines : d.gridlines,
  });

  const scope = readScope(o.scope);
  if (scope === null) return false;
  if (scope.kind === "folder") {
    void useAppStore.getState().openFolder(scope.path, scope.recursive);
  } else {
    void useAppStore.getState().openSource(scope.sourceId, scope.arg);
  }
  return true;
}

/**
 * Keep the saved session current as the user works. Debounced because the
 * stores change on every streamed thumbnail; identical snapshots are not
 * rewritten. Flushed on pagehide so the very last change survives quitting.
 */
export function startSessionPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written: string | null = null;
  const write = () => {
    const next = JSON.stringify(snapshot());
    if (next === written) return;
    written = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A full or unavailable store loses persistence, not the session.
    }
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, 400);
  };
  const unsubscribers = [
    useAppStore.subscribe(schedule),
    useDevelopStore.subscribe(schedule),
  ];
  window.addEventListener("pagehide", write);
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener("pagehide", write);
  };
}
