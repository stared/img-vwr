import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerSourceCommands } from "./commands/sources";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { makeSourcePanel } from "./components/shell/SourcePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerPanel } from "./registry/panels";
import { allSources, registerSource } from "./registry/sources";
import { commonsSource } from "./sources/commons";
import { redditSource } from "./sources/reddit";

registerBuiltinCommands();
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel, fill: true });
for (const source of allSources()) {
  registerPanel({
    id: `source-${source.id}`,
    title: source.sidebarTitle,
    component: makeSourcePanel(source),
  });
}
registerPanel({ id: "stats", title: "Statistics", component: StatsPanel, side: "right", fill: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
