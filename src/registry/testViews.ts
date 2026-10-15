import { getView, registerView } from "./views";

/** The built-in views' contracts without their components, for tests of view-dependent rules. */
export function registerTestViews(): void {
  const views: [id: string, stacks: boolean, zoomable: boolean][] = [
    ["grid", false, false],
    ["mosaic", false, false],
    ["scenes", true, false],
    ["timeline", false, false],
    ["map", false, false],
    ["darkroom", true, true],
  ];
  for (const [id, stacks, zoomable] of views) {
    if (getView(id) !== undefined) continue;
    registerView({ id, label: id, hint: "", component: () => null, keywords: [], zoomable, stacks, Knobs: null });
  }
}
