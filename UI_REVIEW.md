# UI review notes — August 2026

An audit of the shell, taken by walking the running app view by view with
screenshots and reading the shell code, against the photo tools that do
each thing best (Lightroom Classic, Capture One, Photo Mechanic,
darktable, Apple Photos) and the keyboard-first apps that do
discoverability best (Linear, Raycast, VS Code). Notes only — nothing
here has been changed.

## The bars, named

The shell has seven fixed regions. Naming them makes the inconsistencies
visible, because several of them are the same idea implemented twice:

| Region | What it is | Where defined |
| --- | --- | --- |
| Activity bar | 40px icon column, far left; picks ONE left panel | `Sidebar.tsx` |
| Left sidebar | The picked panel (Folders, Reddit, Commons, Similarity, People) | `Sidebar.tsx` |
| Filter bar | The query as chips: scope, filters, `+`, view, sort — plus, in darkroom only, the zoom slider | `FilterBar.tsx` |
| View toolbar | A second row of per-view knobs — but only in some views | `.gallery-toolbar` (grid, scenes), `.tl-toolbar` (timeline) |
| Right sidebar | Develop + Image + Statistics stacked in one scroll | `RightSidebar.tsx` |
| Status bar | path · labels · name · position · pixel size | `StatusBar.tsx` |
| Filmstrip | The darkroom's list | `Filmstrip.tsx` |

**The filter bar has one clear identity** — every chip is a clause of the
query — and it is the strongest idea in the shell; no mainstream tool
states the query this plainly (Lightroom hides it in a collapsible
Library Filter bar most users never open).

**The view toolbar has no identity.** Grid gets a full-width row for one
"per row" slider; scenes gets three permanent algorithm knobs; timeline
gets orientation + size + "show all" + a count; darkroom gets none, its
zoom living in the filter bar instead — the ZoomBar comment even argues
"a line of its own for one slider is not worth the height", which is
exactly the row the grid pays. Two CSS implementations
(`.gallery-toolbar`, `.tl-toolbar`) of the same concept. Options, either
is consistent:

- Fold per-view knobs into the *view chip's* menu (the chip is already
  "how the query renders"; density and scene-break thresholds are
  parameters of that rendering) — the darkroom precedent generalized, and
  every view gains a row of photograph height. Apple Photos does this
  (zoom slider in the toolbar, everything else behind menus).
- Or commit to one always-present view toolbar in all five views, one
  component, zoom included. Lightroom's toolbar (`T`) works like this.

## Left bar, right bar — or the widget chooses

Today the split is: left = collections of photographs (folder tree,
sources, similarity, people), right = properties of the *current*
photograph (develop, info, statistics). That is a real principle and
worth writing down, because nothing in the UI states it.

But the two sides behave like different apps:

- Left: exclusive choice via activity bar, one panel at a time, `⌘B`.
- Right: every panel stacked in one 2000px+ scroll, folding headers,
  visibility toggled by `⌘I` — whose tooltip and command name say
  "statistics" while it hides Develop and Image too (a leftover from when
  Statistics was the only right panel).
- Fold state: `PanelSection` disclosure (`▾/▸`) is `useState` — lost on
  relaunch — while develop's own Groups persist their folds in the
  develop store. Two disclosure grammars, one of which forgets.

The panel registry already has `side: "left" | "right"` per panel — so
"each widget selects its side" is one preference away from being real:
a per-panel side (and order) stored like the session, defaults as today.
Precedents: VS Code drags views between sidebars; Capture One's tool
tabs are fully user-arranged. Not urgent, but the registry was built for
it, and it dissolves the left-vs-right debate into a default rather than
a law.

Smaller observations on the sides:

- The right column would benefit from exclusive tabs or stickier
  structure once a fourth panel arrives; today Develop alone is ~1400px
  and Statistics effectively lives below the fold, reachable only by
  scrolling past every develop control.
- The activity bar mixes icon species: two drawn SVGs (folder,
  similarity), one brand mark (Reddit), one letterform ("W"), one text
  glyph ("☺"). At minimum give People a drawn icon; ideally all five
  share stroke weight. VS Code gets away with icon-only because its
  icons are a designed set.
- Folders panel in a leaf folder is a breadcrumb plus "no subfolders"
  above ~900px of dead column. The dead space is fine (VS Code's
  explorer idles too); the breadcrumb-as-tree is good; but this is where
  a future tree with siblings would earn the column.

## Keybindings

### The map today (from `keybindings.ts`)

- Palette `⌘K`/`⌘P` · folder `⌘O` · sidebar `⌘B` · right bar `⌘I`
- Find `F`/`⌘F` · select all `⌘A` · copy `⌘C` · trash `⌘⌫`
- Navigate `←`/`→`, scenes `⌘←`/`⌘→` · viewer `↵`/`Esc`
- Zoom `=`/`+`/`-`, `⌘0` fit, `⌘1` 1:1 · rate `0–5` · tag `T`
- Develop: export `⌘⇧E`, copy/paste settings `⌘⇧C`/`⌘⇧V`, compare `\`,
  crop `↵`/`Esc`
- `Esc` falls through crop → viewer → selection: the ladder is exactly
  right, and the list-not-map binding table that enables it is a design
  other apps don't have.

Muscle-memory compatibility with Lightroom (digits, `⌘⇧E`, `\`, `⌘⌫`)
is deliberate and correct. Two gaps stand out:

- **No `↑`/`↓`.** The grid is two-dimensional; every reference app moves
  by row. This is the single most-reached-for missing key.
- **No view keys.** Switching grid ↔ darkroom is a two-click chip menu.
  Lightroom's single letters (`G` grid, `D` develop, `E` loupe) are the
  most-used keys it has. Bare letters are free here (only `F`/`T` taken;
  digits rate) — `G`, `D` or a cycle key would transform keyboard flow.

Worth considering, in reference order: Photo Mechanic ranks
speed-per-keystroke above all (single-key everything, no chords for the
culling loop — the bare-digit rating already follows this); Lightroom's
`L` lights-out and `Tab` panels-away are beloved and cheap; `Space` is
unbound and is "zoom toggle" in both LR and Photos.

### How keys are indicated

Today's surfaces, in order of coverage:

1. Palette rows show chords (`formatChord`) — good, but only for the
   bound; 30 commands register `menus: []` and are palette-only.
2. Context menu rows show chords — the code comment even says "the menu
   is how the shortcuts are discovered". Right instinct; but the menu
   *hides* inapplicable commands (`when`) instead of disabling them, so
   e.g. "Paste develop settings" doesn't exist until something is
   copied. Platform convention (macOS menus, LR) is show-disabled:
   a grayed row teaches the command exists and hints why it's inactive.
3. Two tooltips (`⌘I`, `⌘O`) and one inline note — timeline's
   "· ⌘ scroll zooms". That note is the only place any *modifier
   gesture* is advertised, and it's the right pattern: state the
   gesture where the gesture applies.

What the best keyboard apps add, in increasing effort:

- **Chords in every tooltip.** The registry knows every chord
  (`chordsForCommand`); tooltips are already the app's explanation
  channel. "add filter (F for name)" on the `+` chip, "change how the
  results render" + key on the view chip, stars in the rating rows.
  Near-free, and consistent with tooltips-over-prose.
- **A `?` cheatsheet overlay.** Linear/Gmail/GitHub convention: one key,
  a searchable sheet, grouped by area (navigate / rate / develop /
  view). The command + keybinding registries make this a pure render —
  no bookkeeping, plugins included automatically. Highest
  leverage-per-effort item in these notes.
- **A native macOS menu bar.** Tauri menus mirror the command registry;
  accelerators then appear in the one place every Mac user already
  looks, and `Help > Search` indexes every command for free. This is
  the platform-correct answer and also what separates "a webview" from
  "a Mac app" in feel. (It also gives ⌘, ⌘W, ⌘M conventions a home.)
- Farther out: user-editable keymap — the table is already data
  (`defaultKeybindings` merges under a future user keymap, per its own
  comment), which is more than LR offers and what C1 charges for.

## Consistency audit

Found by walking the views; each is small, together they read as three
apps:

1. **Stars render four ways.** Grid/scenes: below the photo, outside
   it, star count only. Filmstrip: on the photo, top-left (the rule
   just established). Status bar: `★` + name. Image panel: `★☆☆☆☆`
   row. One treatment (on-photo, the filmstrip rule) should win
   wherever a thumbnail is drawn; the Image panel's editable row can
   stay, it is a control not a badge.
2. **Stack names diverge.** Filmstrip and status bar say
   `DSC_1424.JPG+NEF`; a scenes cell says `DSC_1424.JPG` for the same
   collapsed pair (`entry.name` vs `pairedName`). Scenes collapses
   stacks, so it should speak `pairedName` too.
3. **The stacking rule is invisible.** `stacksCollapse` is principled
   (collapse where you work one photograph at a time: viewer, darkroom,
   scenes; list every file where you inspect the card: grid, timeline,
   map) — but the UI never says it. The develop panel's
   `raw + JPG: one photograph | two files` control stays lit while the
   grid shows two cells per shot, which reads as the control not
   working. Either the chip row states the exception ("view: grid ·
   shows files"), or the control's tooltip owns it. In the timeline the
   rule also doubles every mark: 290 dots for 145 photographs, JPG and
   NEF landing at the same instant — there "every file" costs signal
   rather than adding honesty.
4. **Menu checkmark grammar.** View menu: `✓ darkroom` as a label
   prefix. Sort, scope and stars menus: right-aligned check column. The
   view menu is the one outlier — pick the column (it keeps labels
   aligned).
5. **Context menu casing and shape.** "Open Image", "Find Similar",
   "Tag Image…", "Move to Trash" (title case) against "Reset develop",
   "Auto tone", "Copy develop settings" (sentence case) in one menu.
   No separators either: Open/Find (navigation), Rating/Tag (labels),
   Export/Crop/develop ops, Copy, Trash are five groups, and the
   destructive row sits flush under Copy — macOS convention is a
   separator before it.
6. **Two selection languages.** Grid: tinted fill + border. Filmstrip:
   overlay frame, 1px selected / 2px lead. Same state, different
   weight. (The filmstrip version is the newer decision.)
7. **Empty states have three voices.** Map: a world map with a corner
   tag "0 of 290 geolocated" (should be a centered sentence — Apple
   Photos: "No items"). People: "looking: 32 / 375", counter of an
   unnamed unit, invisible unless the panel is open. Similarity: a
   paragraph of explanatory prose — the one place the app violates its
   own no-helper-prose rule (that text belongs in tooltips on the two
   model cards).
8. **Duplicated readouts.** Two live histograms (Develop top, Image
   panel); EXIF as Shot facts *and* as the Image panel's EXIF block;
   pixel dimensions in three places. Panels have different jobs, but
   each fact wants one canonical home per column — e.g. the Image
   panel could drop its histogram whenever Develop is visible above it.
9. **Ragged grid rows.** Cells wrap natural-aspect thumbnails, so a
   portrait frame makes its row taller and every name/star sits at a
   different height (visible with mixed orientations). LR/Photos use
   fixed cells with letterboxing for exactly this reason; the
   filmstrip's new square-cell + caption layout is the in-house
   precedent.
10. **Viewer vs darkroom identity.** The viewer is the darkroom minus
    strip and chips, with no mode label, no zoom indicator (darkroom's
    zoom slider is the *only* place magnification is stated, and it
    leaves with the filter bar). Nothing on screen says which of the
    two you are in or how to leave. Worth one deliberate decision:
    either the viewer is a "lights-out" presentation of wherever you
    were (LR's `L`), or it's a mode and says so.
11. **Palette order.** Empty query lists registration order ("Open
    Folder…" forever first). Raycast/VS Code rank by recency after
    first use; with `searchCommands` already scoring, a recency bump is
    a small change with daily payoff.
12. (To verify on screen: over the map view my captures clipped the
    palette list to two rows while the DOM measured ten — almost
    certainly a screenshot/compositing artifact over Leaflet, but worth
    one glance at the real window.)

## What already beats the references — keep

- The query-as-chips bar, including the segmented sort chip whose every
  token is a click target. No shipping DAM states its query this well.
- The keybinding table as ordered list with `when`-guarded fallthrough
  (the Escape ladder) — cleaner than LR's mode-dependent keymap sprawl.
- Registry-driven everything (commands, menus, panels, filters, sorts,
  facts): the `?` overlay, menu bar, and keymap editor above are all
  renders of data that already exists. This is the architecture VS Code
  had to grow into.
- Rating/culling loop: bare digits + arrows + one-click stack spread +
  `⌘⌫` guarded delete is already Photo Mechanic-grade for speed.
- Tooltips as the explanation channel, consistently present on nearly
  every control (the slider/mark/readout component especially).
- The export dialog: five rows and a sentence that states the plan
  before anything is written ("1 photograph, all copied from the
  camera's JPG"). Lightroom needs six collapsible sections to say less.
  One nit: it dismisses only by `Esc` or clicking outside, with no
  visible Cancel — worth a small close affordance, since this is the
  one dialog a user might reach warily.

## If ordering the notes into work (smallest first within each tier)

1. `?` shortcut overlay rendered from the registries; chords appended to
   tooltips systematically.
2. `↑`/`↓` in the grid; single-key view switching, keys shown in the
   view menu.
3. Rename/re-scope `⌘I` (inspector, not statistics); persist
   `PanelSection` folds like develop's.
4. One star treatment + `pairedName` in scenes; checkmark column and
   context-menu separators/casing.
5. One view-toolbar story (fold into view chip, or one component for
   all views, zoom included).
6. Empty-state voice pass (map, People, Similarity prose → tooltips).
7. Native macOS menu bar from the command registry.
8. Panel side/order as a stored preference (registry already models
   `side`).
