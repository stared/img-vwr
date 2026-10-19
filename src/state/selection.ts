import type { FileEntry } from "../ipc";
import { getView } from "../registry/views";
import type { Query } from "./query";
import { siblingsOf, stackKeyOf, stackKeyOfPath } from "./stacks";
import { without } from "./collection";
import type { AppState } from "./store";
import { visibleOf } from "./visible";

/* Selection as pure transitions: each takes the state it reads and returns the patch to apply. */

/** From an empty selection an arrow enters at the end it points from: ← lands on the last image, → the first. */
export function movedSelection(
  state: Pick<AppState, "selectedIndex">,
  count: number,
  delta: number,
): Partial<AppState> {
  if (count === 0) return {};
  const index =
    state.selectedIndex === null
      ? delta < 0
        ? count - 1
        : 0
      : Math.min(count - 1, Math.max(0, state.selectedIndex + delta));
  if (index === state.selectedIndex) return {};
  return { selectedIndex: index };
}

/** The viewport is deliberately left alone: a zoomed view holds its place across selection changes — see `heldView`. */
export function withSelection(state: VisibleInputs, index: number | null): Partial<AppState> {
  const entry = index === null ? undefined : visibleOf(state, state.query)[index];
  if (index === null || entry === undefined) {
    return { selectedIndex: null, selection: [], selectionAnchor: null };
  }
  return { selectedIndex: index, selection: [entry.path], selectionAnchor: entry.path };
}

export type SelectMode =
  /** This one instead of whatever was selected. */
  | "replace"
  /** This one as well, or out again if it was already in (⌘/Ctrl). */
  | "extend"
  /** Everything from the anchor through to this one (⇧). */
  | "range";

export function selectMode(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): SelectMode {
  if (e.shiftKey) return "range";
  if (e.metaKey || e.ctrlKey) return "extend";
  return "replace";
}

/** Click on the image at `index` — see `SelectMode`. */
export function withSelectionAt(
  state: VisibleInputs,
  index: number,
  mode: SelectMode,
): Partial<AppState> {
  const visible = visibleOf(state, state.query);
  const entry = visible[index];
  if (entry === undefined) return {};

  if (mode === "replace") return withSelection(state, index);

  if (mode === "extend") {
    if (!state.selection.includes(entry.path)) {
      // Picked up: the lead and the anchor both move onto it — a range reaches from the last thing touched.
      return {
        selectedIndex: index,
        selection: [...state.selection, entry.path],
        selectionAnchor: entry.path,
      };
    }
    // Put back down: the lead moves to the first of the rest; taking the last one out leaves nothing selected.
    const rest = new Set(state.selection.filter((p) => p !== entry.path));
    const lead = visible.findIndex((e) => rest.has(e.path));
    const leadEntry = lead < 0 ? undefined : visible[lead];
    if (leadEntry === undefined) {
      return { selectedIndex: null, selection: [], selectionAnchor: null };
    }
    return {
      selectedIndex: lead,
      selection: visible.filter((e) => rest.has(e.path)).map((e) => e.path),
      selectionAnchor: leadEntry.path,
    };
  }

  // A range with nothing to reach from is just a click.
  const anchored = visible.findIndex((e) => e.path === state.selectionAnchor);
  const from = anchored < 0 ? index : anchored;
  const [lo, hi] = from <= index ? [from, index] : [index, from];
  return {
    selectedIndex: index,
    selection: visible.slice(lo, hi + 1).map((e) => e.path),
    // The anchor stays put, so reaching back the other way corrects the range.
    selectionAnchor: visible[from]?.path ?? entry.path,
  };
}

/** Everything `visibleOf` reads, plus the selection it is an index into. */
export type VisibleInputs = Pick<
  AppState,
  | "entries"
  | "query"
  | "selectedIndex"
  | "selection"
  | "selectionAnchor"
  | "stacking"
  | "stackLead"
  | "preferredMember"
  | "viewMode"
  | "galleryLayout"
>;

/** Stacking applies only where one photograph is on screen at a time (the viewer, and views that say so). */
export function stacksCollapse(
  state: Pick<AppState, "stacking" | "viewMode" | "galleryLayout">,
): boolean {
  return state.stacking && (state.viewMode === "viewer" || getView(state.galleryLayout)?.stacks === true);
}

/** The photographs the selection means, in the order they are on screen. */
export function chosenEntries(state: AppState): FileEntry[] {
  const picked = new Set(state.selection);
  return visibleOf(state, state.query).filter((e) => picked.has(e.path));
}

/** Where a pair is collapsed into one photograph, acting on "it" means both files; where listed apart, only the picked file. */
export function filesBehind(state: AppState, entries: FileEntry[]): FileEntry[] {
  if (!stacksCollapse(state)) return entries;
  const files = new Map<string, FileEntry>();
  for (const entry of entries) {
    files.set(entry.path, entry);
    for (const sibling of siblingsOf(state.entries, entry)) files.set(sibling.path, sibling);
  }
  return [...files.values()];
}

/** Re-expresses the selection by path across a list change; `landOn` overrides where the lead lands (e.g. picking a pair's JPEG). */
export function withSelectionHeld(
  state: VisibleInputs,
  patch: Partial<AppState>,
  landOn?: string,
): Partial<AppState> {
  const before =
    state.selectedIndex === null
      ? undefined
      : visibleOf(state, state.query)[state.selectedIndex]?.path;
  const next = { ...state, ...patch } as VisibleInputs;
  const after = visibleOf(next, next.query);
  return {
    ...patch,
    ...reselected(after, landOn ?? before ?? null, state.selection, state.selectionAnchor),
  };
}

/** The selection, re-expressed against a visible list that just changed. */
function reselected(
  after: FileEntry[],
  wanted: string | null,
  chosen: readonly string[],
  anchor: string | null,
): Pick<AppState, "selectedIndex" | "selection" | "selectionAnchor"> {
  let index = wanted === null ? -1 : after.findIndex((e) => e.path === wanted);
  if (index < 0 && wanted !== null) {
    // The file may survive as the other of its pair — collapsing a stack is exactly that.
    const key = stackKeyOfPath(wanted);
    index = after.findIndex((e) => stackKeyOf(e) === key);
  }
  // Rebuilt from the list, so the selection stays in on-screen order however the sort just moved it.
  const want = new Set(chosen);
  const survivors = want.size === 0 ? [] : after.filter((e) => want.has(e.path));
  const first = survivors[0];
  if (index < 0 && first !== undefined) {
    // The lead is gone but other picked photographs survive; the lead moves onto the first of them.
    index = after.indexOf(first);
  }
  const lead = index < 0 ? undefined : after[index];
  if (lead === undefined) return { selectedIndex: null, selection: [], selectionAnchor: null };
  // The lead is in the selection by construction — even when it arrived as the other half of a stack.
  const selection = after.filter((e) => e === lead || want.has(e.path)).map((e) => e.path);
  return {
    selectedIndex: index,
    selection,
    selectionAnchor:
      anchor !== null && after.some((e) => e.path === anchor) ? anchor : lead.path,
  };
}

/** Applied the moment a delete returns (the watcher reports later and finds nothing to do); deleting the lead lands on whatever takes its place. */
export function withDeleted(
  state: VisibleInputs & Pick<AppState, "thumbs" | "thumbErrors">,
  gone: readonly string[],
): Partial<AppState> {
  const drop = new Set(gone);
  const entries = state.entries.filter((e) => !drop.has(e.path));
  if (entries.length === state.entries.length) return {};
  const patch = {
    entries,
    thumbs: without(state.thumbs, drop),
    thumbErrors: without(state.thumbErrors, drop),
  };
  const held = withSelectionHeld(state, patch);
  if (held.selectedIndex !== null || state.selectedIndex === null) return held;
  const after = visibleOf({ ...state, ...patch } as VisibleInputs, state.query);
  const index = Math.min(state.selectedIndex, after.length - 1);
  const landing = index < 0 ? undefined : after[index];
  if (landing === undefined) return held;
  return { ...held, selectedIndex: index, selection: [landing.path], selectionAnchor: landing.path };
}

/** Photographs that survive the new filters stay selected; the rest are dropped, never replaced. */
export function withQuery(state: VisibleInputs, query: Query, landOn?: string): Partial<AppState> {
  const held = withSelectionHeld(state, { query }, landOn);
  // A filter that hides the viewed photograph must not strand an empty viewer; it yields to the gallery.
  if (state.viewMode === "viewer" && held.selectedIndex === null) {
    return { ...held, viewMode: "gallery" };
  }
  return held;
}
