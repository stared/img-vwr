import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerSourceCommands } from "./commands/sources";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerPanel } from "./registry/panels";
import { registerSource } from "./registry/sources";
import { commonsSource } from "./sources/commons";
import { redditSource } from "./sources/reddit";

registerBuiltinCommands();
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel });
registerPanel({ id: "stats", title: "Statistics", component: StatsPanel, side: "right" });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
