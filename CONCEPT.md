# imgvwr — concept

An extensible image viewer.

Key inspirations: VS Code and Obsidian, with some UI inspirations from Linear.app.

Rust for compute, strict TypeScript (never plain JS) for visualization.
Functional approach whenever possible, to have clear input and output, minimal internal state.
Modularity: clear, explicit contracts (typed interfaces); extensions plug in the same way as built-ins.

Principles:

- Filters and sort are an explicit query: `key: value` chips; the path is a filter; sort always exists, so it is always shown.
- Minimalism: if something does not actively add value, drop it.
- User-centric: the user never waits on the app — e.g. display first, compute in the background.
