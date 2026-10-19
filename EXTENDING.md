# Extending imgvwr

A feature is a folder plus one registration line on each side. Everything it
needs from the core goes through a registry; the core never imports a
feature (`eslint` enforces this for `src/`). The test of a well-formed
feature: delete its folder and its registration lines, and typecheck, lint
and tests still pass.

`src/features/labels/` is the smallest complete example; `people/`,
`scenes/` (a whole gallery view) and `similarity/` follow the same shape.

## Frontend: `src/features/<name>/`

```
index.tsx    register<Name>(): every registry call the feature makes
store.ts     its own zustand store, and the channels it publishes
*.tsx        its panels, menus, badges
<name>.css   its styles, imported by index.tsx
```

Add `register<Name>()` to `src/main.tsx`. Registries, all in `src/registry/`:

| registry | contributes |
|---|---|
| `channels.ts` | per-photo data (`Channel<T>`) that filters and sorts read |
| `filters.ts` | a field in the "+" menu: select, flags, range, menu or action |
| `sorts.ts` | a sort; `param` for sorts that need an argument (closest-to) |
| `commands.ts` | a command for the palette, context menu and keys |
| `keybindings.ts` | `registerKeybindings` — the feature's default chords |
| `panels.ts` | a left or right sidebar panel, placed by `order` |
| `badges.tsx` | a mark on gallery cells and in the status bar |
| `views.tsx` | a gallery view, with its own `Knobs` and stacking rule |
| `sources.ts` | an image source besides folders (Reddit, Commons) |
| `facts.ts` | a line of photo facts |

### Per-photo data

A feature that knows something about each photograph publishes it as a
channel over its own store:

```ts
export const LABELS = storeChannel(useLabelsStore, (s) => s.labels, UNLABELED);
```

Fields and sorts name the channels they read and get values through
`data.get(...)`:

```ts
registerSort({
  id: "stars",
  reads: [LABELS],
  value: (_entry, data) => data.get(LABELS).stars,
  // …
});
```

The visible list re-derives only when a channel the active query reads
changes, so a feature's streaming updates cost nothing while nobody filters
or sorts by them.

### Scope changes

A new folder bumps `useAppStore`'s `epoch`. A feature's store resets itself
by watching it (see `followScope` in `features/people/store.ts`) and drops
late results tagged with an old epoch.

## Backend: `src-tauri/src/features/<name>.rs`

One module holds the feature's service, its `#[tauri::command]`s and its
events. Wire it in `src-tauri/src/lib.rs`: the commands in
`collect_commands!`, events in `collect_events!`, the service in `setup`
with `app.manage(...)`. Then run `pnpm gen:bindings` to regenerate the typed
TypeScript bindings in `src/ipc/bindings.ts`.

Shared infrastructure lives in `src-tauri/src/services/` (thumbnails,
develop, embeddings, export, watcher) with its commands beside it; pure,
Tauri-free code lives in the crates under `src-tauri/crates/`. New file
formats plug in there through `ImageCodec` (display-ready pixels) or
`SceneFormat` (scene-linear, re-renderable) — see the README.

User data (labels, edits, names) goes to the app data directory, never
beside the photographs.
