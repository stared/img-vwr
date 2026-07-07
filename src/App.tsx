import { useEffect } from "react";

import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { CommandPalette } from "./components/shell/CommandPalette";
import { Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { useGlobalKeybindings } from "./components/shell/useGlobalKeybindings";
import { ImageViewer } from "./components/viewer/ImageViewer";
import { events } from "./ipc";
import { executeCommand } from "./registry/commands";
import { useAppStore } from "./state/store";
import "./App.css";

function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const count = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);

  useGlobalKeybindings();

  // Stream thumbnail and folder-count results from Rust into the store.
  useEffect(() => {
    const { thumbReady, thumbFailed, dirCountReady } = useAppStore.getState();
    const unlisteners = [
      events.thumbnailReady.listen(({ payload }) =>
        thumbReady(payload.path, payload.cacheFile, payload.epoch),
      ),
      events.thumbnailFailed.listen(({ payload }) =>
        thumbFailed(payload.path, payload.error, payload.epoch),
      ),
      events.dirCountReady.listen(({ payload }) =>
        dirCountReady(payload.path, payload.imageCount),
      ),
    ];
    return () => {
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar />
        <main className="main-pane">
          {status === "idle" && (
            <div className="empty-state">
              <p>No folder open.</p>
              <button onClick={() => executeCommand("folder.open", { store: useAppStore })}>
                Open Folder <kbd>⌘O</kbd>
              </button>
            </div>
          )}
          {status === "loading" && <p className="hint">Scanning…</p>}
          {status === "error" && <p className="error">{error}</p>}
          {status === "loaded" && count === 0 && <p className="hint">No images in this folder.</p>}
          {status === "loaded" &&
            count > 0 &&
            (viewMode === "viewer" ? <ImageViewer /> : <GalleryGrid />)}
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}

export default App;
