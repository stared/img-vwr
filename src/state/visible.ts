import { useCallback, useSyncExternalStore } from "react";

import type { FileEntry } from "../ipc";
import type { ChannelMaps } from "../registry/channels";
import { applyQuery, channelsRead, type Query } from "./query";
import { collapseStacks, type StackLead } from "./stacks";
import { stacksCollapse, type VisibleInputs } from "./selection";
import { useAppStore, type AppState } from "./store";

/** The lead photograph's path in the visible list; undefined when nothing is selected. */
export function leadPath(state: VisibleInputs): string | undefined {
  return state.selectedIndex === null
    ? undefined
    : visibleOf(state, state.query)[state.selectedIndex]?.path;
}

/* All consumers share one memoized filter+sort result, held by input identity; one slot suffices since every consumer reads the same store state. */
let visibleCache: {
  entries: FileEntry[];
  query: Query;
  /** The maps of the channels the query reads, in `channelsRead` order. */
  maps: readonly unknown[];
  stacking: boolean;
  lead: StackLead;
  preferred: Record<string, string>;
  result: FileEntry[];
} | null = null;

/** Entries with filters + sort applied, memoized across all callers. Channel data is read live, never from `state`. */
export function visibleOf(
  state: Pick<
    AppState,
    "entries" | "stacking" | "stackLead" | "preferredMember" | "viewMode" | "galleryLayout"
  >,
  query: Query,
): FileEntry[] {
  // Only channels the query reads participate — streaming batches must not re-sort what a plain name sort ignores.
  const channels = channelsRead(query);
  const maps = channels.map((c) => c.read());
  const stacking = stacksCollapse(state);
  const c = visibleCache;
  if (
    c &&
    c.entries === state.entries &&
    c.query === query &&
    c.maps.length === maps.length &&
    c.maps.every((m, i) => m === maps[i]) &&
    c.stacking === stacking &&
    c.lead === state.stackLead &&
    c.preferred === state.preferredMember
  ) {
    return c.result;
  }
  const byChannel: ChannelMaps = new Map(channels.map((ch, i) => [ch, maps[i] ?? {}]));
  const filtered = applyQuery(state.entries, query, byChannel);
  // Stacking collapses what the query already decided, so a filter matching one member of a pair still shows it.
  const result = stacking ? collapseStacks(filtered, state.preferredMember, state.stackLead) : filtered;
  visibleCache = {
    entries: state.entries,
    query,
    maps,
    stacking,
    lead: state.stackLead,
    preferred: state.preferredMember,
    result,
  };
  return result;
}

/** Every panel that describes "the current image" goes through here, so all agree on the empty case. */
export function useSelectedEntry(): FileEntry | null {
  const entries = useVisibleEntries();
  const index = useAppStore((s) => s.selectedIndex);
  return index === null ? null : (entries[index] ?? null);
}

export function useVisibleEntries(): FileEntry[] {
  const query = useAppStore((s) => s.query);
  // Listens to the store and to exactly the channels this query reads; the memo turns everything else into a no-op.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = [useAppStore.subscribe(onChange), ...channelsRead(query).map((c) => c.subscribe(onChange))];
      return () => offs.forEach((off) => off());
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => {
    const state = useAppStore.getState();
    return visibleOf(state, state.query);
  });
}
