import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { events } from "./ipc";
import { useAppStore } from "./state/store";
import "./App.css";

function App() {
  const folderPath = useAppStore((s) => s.folderPath);
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const count = useAppStore((s) => s.entries.length);
  const openFolder = useAppStore((s) => s.openFolder);

  // Stream thumbnail results from Rust into the store.
  useEffect(() => {
    const { thumbReady, thumbFailed } = useAppStore.getState();
    const unlistenReady = events.thumbnailReady.listen(({ payload }) =>
      thumbReady(payload.path, payload.cacheFile, payload.epoch),
    );
    const unlistenFailed = events.thumbnailFailed.listen(({ payload }) =>
      thumbFailed(payload.path, payload.error, payload.epoch),
    );
    return () => {
      void unlistenReady.then((fn) => fn());
      void unlistenFailed.then((fn) => fn());
    };
  }, []);

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
        {status === "loaded" && <span className="count">{count} images</span>}
      </header>

      {status === "loading" && <p className="hint">Scanning…</p>}
      {status === "error" && <p className="error">{error}</p>}
      {status === "loaded" && count === 0 && <p className="hint">No images in this folder.</p>}
      {status === "loaded" && count > 0 && <GalleryGrid />}
    </main>
  );
}

export default App;
