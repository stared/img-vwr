/* Per-photo data a feature publishes for filters and sorts to read. Fields and sorts name the channels they read,
   so the visible list re-derives only when one of those changes — a streaming meta batch never re-sorts by name. */

export interface Channel<T> {
  /** What a photo absent from the map reads as: empty (unlabeled) or undefined (not read yet). */
  missing: T;
  /** path → value; a new map identity on every change. */
  read: () => Readonly<Record<string, T>>;
  subscribe: (onChange: () => void) => () => void;
}

/** A field's or sort's view of one photo. */
export interface PhotoData {
  get: <T>(channel: Channel<T>) => T;
}

/** The channels a field or sort reads; empty when the file entry alone decides. */
export type Reads = readonly Channel<unknown>[];

/** Channel maps keyed by handle, for the channels a query reads. */
export type ChannelMaps = ReadonlyMap<Channel<unknown>, Readonly<Record<string, unknown>>>;

export function photoData(maps: ChannelMaps, path: string): PhotoData {
  return {
    get: <T>(channel: Channel<T>): T => {
      const map = maps.get(channel as Channel<unknown>);
      // A channel the caller did not supply reads as missing everywhere, never as a crash.
      return map !== undefined && path in map ? (map[path] as T) : channel.missing;
    },
  };
}

/** A channel over a slice of a zustand store. */
export function storeChannel<S, T>(
  store: { getState: () => S; subscribe: (listener: () => void) => () => void },
  select: (state: S) => Readonly<Record<string, T>>,
  missing: T,
): Channel<T> {
  return {
    missing,
    read: () => select(store.getState()),
    subscribe: (onChange) => store.subscribe(onChange),
  };
}
