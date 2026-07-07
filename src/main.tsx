import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { registerBuiltinCommands } from "./commands/builtin";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { registerPanel } from "./registry/panels";

registerBuiltinCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
