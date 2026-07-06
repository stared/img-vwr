import { open } from "@tauri-apps/plugin-dialog";

import { useAppStore } from "./state/store";
import "./App.css";

function App() {
  const { folderPath, entries, status, error, openFolder } = useAppStore();

  const pickFolder = async () => {
    const selected = await open({ directory: true, title: "Open Folder" });
    if (typeof selected === "string") {
      await openFolder(selected);
    }
  };

  return (
    <main className="app">
      <header className="toolbar">
        <button onClick={() => void pickFolder()}>Open Folder</button>
        <span className="folder-path">{folderPath ?? "No folder open"}</span>
        {status === "loaded" && <span className="count">{entries.length} images</span>}
      </header>

      {status === "loading" && <p className="hint">Scanning…</p>}
      {status === "error" && <p className="error">{error}</p>}
      {status === "loaded" && entries.length === 0 && (
        <p className="hint">No images in this folder.</p>
      )}

      <ul className="file-list">
        {entries.map((entry) => (
          <li key={entry.path}>
            <span className="file-name">{entry.name}</span>
            <span className="file-meta">
              {entry.formatHint} · {formatSize(entry.size)}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default App;
