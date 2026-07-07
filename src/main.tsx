import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands } from "./commands/builtin";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerPanel } from "./registry/panels";

registerBuiltinCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel });
registerPanel({ id: "stats", title: "Statistics", component: StatsPanel, side: "right" });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
