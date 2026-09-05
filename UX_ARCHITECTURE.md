# UX architecture: plugin-first image workspace

This document is the product contract behind the shell. It complements
`DESIGN.md`, which records decisions inside individual tools.

The app is not divided into Library and Develop modes. That split would make
the large-image presentation, filmstrip, histogram, labels, and metadata feel
owned by editing when they are useful without it. Instead, the app follows the
same compositional idea as VS Code: inputs, commands, views, and panels are
independent contributions around shared workspace state.

## The data flow

```text
input -> collection -> query -> ordered results -> view
                    \                         \
                     metadata                 focus + selection
                                                |
                                  panels + commands + status
```

1. **Input** answers where images come from: a folder, Reddit, Commons, or a
   future plugin. It produces a collection and owns only source-specific
   parameters and loading errors.
2. **Collection** is the canonical set of image entries plus progressively
   arriving facts: thumbnails, metadata, labels, crops, embeddings, people,
   and stacks. No mounted view owns collection enrichment.
3. **Query** turns a collection into ordered results. Filters and sorts are
   contributed independently and survive presentation changes.
4. **View** renders the ordered results. Grid, mosaic, scenes, timeline, map,
   and the main-image-with-filmstrip presentation are peers. A view may expose
   presentation options and navigation geometry, but it must not own the
   collection, query, selection, or editing session.
5. **Focus** is the one result described by contextual panels. **Selection**
   is the set affected by bulk commands. Focus is always inside selection, but
   the two remain visibly distinct.
6. **Panels** consume shared context. Develop is one panel among Shot, Loupe,
   Histogram, Labels, Colors, and future plugin panels. It does not define a
   central application mode.
7. **Commands** are the common action layer for shortcuts, the command
   palette, context menus, and visible contextual actions.

This separation means a carousel, compare view, contact sheet, slideshow,
face wall, or plugin-defined scientific view can be added without learning
about Develop and without duplicating input, query, or selection behavior.

## Shell hierarchy

The shell should answer six questions without requiring a tooltip:

1. What input is open?
2. How many results does the current query produce?
3. Which view is rendering them?
4. Which image has focus?
5. How many images are selected and therefore affected by a command?
6. What background work or error changes the trustworthiness of the result?

The top workspace bar therefore presents input and query on the left, result
count plus view and sort on the right. When selection becomes plural, a
context bar names both its size and focused image and exposes common commands.
The status bar retains full paths and image dimensions for detailed inspection.

## Extension contracts

### Inputs

An input contributes an id, title, argument collector, loader, applicable
sorts/filters, and optional sidebar panel. Changing input replaces collection
data; it does not choose a view.

### Views

A view contributes:

- stable typed id, label, and description;
- central React component;
- optional command keywords and shortcut;
- optional presentation-controls component;
- capabilities such as two-dimensional navigation or zoom controls.

The shell enumerates the registry. Built-in ids remain a closed TypeScript
union today; opening that type is a future plugin-API decision, not something
the internal registry should weaken pre-emptively. The central renderer and
menu must not acquire another conditional branch merely because a built-in
view was added.

### Panels

A panel contributes its side, title, component, visibility predicate, and
layout preference. Predicates may read workspace context, but a central view
must not explicitly activate editing panels. Users decide which applicable
panels are open; context only decides whether their content is meaningful.

### Commands

Every consequential action is a command. Visible buttons invoke commands
rather than reimplementing behavior. Commands state applicability from shared
context and should describe bulk reach in the UI when selection is plural.

## Interaction invariants

- A view change preserves query, focus, and selection by image identity.
- A query change preserves focus when the focused image remains visible.
- Panels describe focus; bulk commands affect selection.
- Opening a transient viewer and returning restores the previous view and
  scroll context.
- Views may preserve zoom while stepping between comparable images, but zoom
  persistence must be explicit when crossing presentation boundaries.
- Input photographs are never modified. Destructive file commands resolve
  their exact backing files and confirm before acting.
- Loading, empty, partial, and error states belong to the input/collection
  layer and render consistently in every view.

## Product stories guiding the shell

- Open a folder and understand immediately that files stay in place.
- Filter or sort once, then inspect the same results in any installed view.
- Select several photographs, keep one clearly focused, and know which actions
  affect all versus only the focused image.
- Use the main-image-and-filmstrip view as a carousel, culling loupe, metadata
  inspector, or editing surface depending on the panels currently visible.
- Install a new view or panel without changing the data pipeline or teaching
  other contributions about it.

## Delivery priorities

1. Make view contribution real: central rendering and view menus enumerate a
   registry rather than hardcoded conditionals.
2. Clarify focus versus selection and expose contextual bulk commands.
3. Improve first-run, empty, loading, and error communication.
4. Separate visual treatment of input, query, view, and sort in the workspace
   bar while keeping them composable.
5. Add undo/history, culling flags, reusable saved queries, and richer compare
   views as contributions on top of the same pipeline.
