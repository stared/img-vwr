import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands, registerSortCommands } from "./commands/builtin";
import { registerCopyCommands } from "./commands/copy";
import { registerDevelopCommands } from "./commands/develop";
import { registerSceneCommands } from "./commands/scenes";
import { registerSourceCommands } from "./commands/sources";
import { registerTrashCommands } from "./commands/trash";
import { DevelopLoupe } from "./components/develop/DevelopLoupe";
import { DevelopPanel } from "./components/develop/DevelopPanel";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { FolderIcon, SimilarityIcon, SOURCE_ICONS } from "./components/shell/icons";
import { ColorsPanel, HistogramPanel, LabelsPanel, ShotPanel } from "./components/shell/InfoPanel";
import { SimilarityPanel } from "./components/shell/SimilarityPanel";
import { makeSourcePanel } from "./components/shell/SourcePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerCommand } from "./registry/commands";
import { allPanels, registerPanel } from "./registry/panels";
import { allSources, registerSource } from "./registry/sources";
import { registerBuiltinFacts } from "./facts/builtin";
import { registerBuiltinFilterFields } from "./filters/builtin";
import { registerLabels } from "./labels";
import { registerThumbCrops } from "./state/thumbCrops";
import { useDevelopStore } from "./state/develop";
import { useAppStore } from "./state/store";
import { PeoplePanel, registerPeople } from "./people";
import { registerSimilarity } from "./similarity";
import { commonsSource } from "./sources/commons";
import { redditSource } from "./sources/reddit";
import { registerBuiltinSorts } from "./sorts/builtin";

registerBuiltinCommands();
registerBuiltinSorts();
registerBuiltinFilterFields();
registerBuiltinFacts();
// Sources bring their own scope-specific sorts, so they register first;
// the sort commands then cover built-ins and source sorts alike.
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
registerSimilarity();
registerLabels();
registerThumbCrops();
registerPeople();
registerDevelopCommands();
registerSceneCommands();
// Last, so the one destructive action sits at the bottom of the image menu.
// Copy before Trash: the menu lists them in registration order, and the
// destructive one belongs at the end.
registerCopyCommands();
registerTrashCommands();
registerSortCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel, icon: <FolderIcon /> });
for (const source of allSources()) {
  registerPanel({
    id: `source-${source.id}`,
    title: source.sidebarTitle,
    component: makeSourcePanel(source),
    icon: SOURCE_ICONS[source.id] ?? source.glyph,
  });
}
registerPanel({
  id: "similarity",
  title: "Similarity",
  component: SimilarityPanel,
  icon: <SimilarityIcon />,
});
registerPanel({ id: "people", title: "People", component: PeoplePanel, icon: "☺" });
// The right column: flat sections, each collapsible and reorderable —
// registration order is the default order. Develop shows only where
// developing happens (darkroom, viewer).
const selected = () => useAppStore.getState().selectedIndex !== null;
const inSession = () => useDevelopStore.getState().session !== null;
registerPanel({ id: "shot", title: "Shot", component: ShotPanel, side: "right", when: selected });
registerPanel({ id: "loupe", title: "Loupe", component: DevelopLoupe, side: "right", when: inSession });
registerPanel({
  id: "histogram",
  title: "Histogram",
  component: HistogramPanel,
  side: "right",
  when: inSession,
});
registerPanel({
  id: "develop",
  title: "Develop",
  component: DevelopPanel,
  side: "right",
  when: () => {
    const s = useAppStore.getState();
    return s.galleryLayout === "darkroom" || s.viewMode === "viewer";
  },
});
registerPanel({ id: "labels", title: "Labels", component: LabelsPanel, side: "right", when: selected });
registerPanel({ id: "colors", title: "Colors", component: ColorsPanel, side: "right", when: selected });
registerPanel({ id: "stats", title: "Statistics", component: StatsPanel, side: "right", fill: true });
// Every left panel is reachable from the palette, like VS Code's view commands.
for (const panel of allPanels()) {
  registerCommand({
    id: `view.${panel.id}`,
    title: `Show ${panel.title}`,
    keywords: ["view", "panel", "sidebar"],
    menus: [],
    run: ({ store }) => store.getState().setActivePanel(panel.id),
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
