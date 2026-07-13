import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands, registerSortCommands } from "./commands/builtin";
import { registerSourceCommands } from "./commands/sources";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { FolderIcon, SimilarityIcon, SOURCE_ICONS } from "./components/shell/icons";
import { SimilarityPanel } from "./components/shell/SimilarityPanel";
import { makeSourcePanel } from "./components/shell/SourcePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerCommand } from "./registry/commands";
import { allPanels, registerPanel } from "./registry/panels";
import { allSources, registerSource } from "./registry/sources";
import { registerBuiltinFilterFields } from "./filters/builtin";
import { registerLabels } from "./labels";
import { registerSimilarity } from "./similarity";
import { commonsSource } from "./sources/commons";
import { redditSource } from "./sources/reddit";
import { registerBuiltinSorts } from "./sorts/builtin";

registerBuiltinCommands();
registerBuiltinSorts();
registerBuiltinFilterFields();
// Sources bring their own scope-specific sorts, so they register first;
// the sort commands then cover built-ins and source sorts alike.
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
registerSimilarity();
registerLabels();
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
