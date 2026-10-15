import { create } from "zustand";

type Setting = number | string;

/**
 * A feature's own settings, remembered per viewer under `key`. A stored value is used only when it has its
 * default's type (and is one of `allowed`, where given); `legacy` names where the old app-session record kept
 * each field, read once when the feature has no record of its own yet.
 */
export function settingsStore<T extends Record<string, Setting>>(
  key: string,
  defaults: T,
  allowed: { [K in keyof T]?: readonly T[K][] },
  legacy: { [K in keyof T]: string },
) {
  const restored = (): T => {
    try {
      const own = localStorage.getItem(key);
      const raw = own ?? localStorage.getItem("imgvwr.session.v1");
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return defaults;
      const record = parsed as Record<string, unknown>;
      const out = { ...defaults };
      for (const field of Object.keys(defaults) as (keyof T)[]) {
        const value = record[own === null ? legacy[field] : (field as string)];
        const choices = allowed[field];
        if (typeof value === typeof defaults[field] && (choices === undefined || choices.includes(value as T[typeof field]))) {
          out[field] = value as T[typeof field];
        }
      }
      return out;
    } catch {
      return defaults;
    }
  };
  const save = (settings: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // Private mode or full storage: the setting just lasts for this session.
    }
  };
  const store = create<T>()(() => restored());
  // Written at once, so values taken from the old session record outlive that record's next rewrite.
  save(store.getState());
  store.subscribe(save);
  return store;
}
