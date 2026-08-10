import { useEffect } from "react";

import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { DarkroomGallery } from "./components/gallery/DarkroomGallery";
import { MapGallery } from "./components/gallery/MapGallery";
import { TimelineGallery } from "./components/gallery/TimelineGallery";
import { CommandPalette } from "./components/shell/CommandPalette";
import { FilterBar } from "./components/shell/FilterBar";
import { ImageContextMenu } from "./components/shell/ImageContextMenu";
import { DEFAULT_START_FOLDER } from "./config";
import { RightSidebar } from "./components/shell/RightSidebar";
import { Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { useGlobalKeybindings } from "./components/shell/useGlobalKeybindings";
import { ImageViewer } from "./components/viewer/ImageViewer";
import { events } from "./ipc";
import { useSceneRefinement } from "./state/sceneRefinement";
import { useAppStore } from "./state/store";
import "./App.css";

function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const count = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const galleryLayout = useAppStore((s) => s.galleryLayout);

  useGlobalKeybindings();
  useSceneRefinement();

  // Start in the default folder (testing convenience; see config.ts).
  useEffect(() => {
    const { status, openFolder } = useAppStore.getState();
    if (DEFAULT_START_FOLDER && status === "idle") {
      void openFolder(DEFAULT_START_FOLDER, false);
    }
  }, []);

  // Stream thumbnail, folder-count and metadata results from Rust into the store.
  useEffect(() => {
    const { scanBatch, folderChanged, thumbReady, thumbFailed, dirCountReady, metaBatchReady } =
      useAppStore.getState();
    const unlisteners = [
      events.scanBatch.listen(({ payload }) =>
        scanBatch(payload.entries, payload.epoch, payload.done),
      ),
      // The open folder was re-read after something changed on disk.
      events.folderChanged.listen(({ payload }) =>
        folderChanged(payload.entries, payload.epoch),
      ),
      events.thumbnailReady.listen(({ payload }) =>
        thumbReady(payload.path, payload.cacheFile, payload.epoch),
      ),
      events.thumbnailFailed.listen(({ payload }) =>
        thumbFailed(payload.path, payload.error, payload.epoch),
      ),
      events.dirCountReady.listen(({ payload }) =>
        dirCountReady(payload.path, payload.imageCount),
      ),
      events.metaBatchReady.listen(({ payload }) =>
        metaBatchReady(payload.items, payload.epoch),
      ),
      events.facesProgress.listen(({ payload }) => {
        const s = useAppStore.getState();
        if (payload.epoch === s.epoch) {
          s.setFacesProgress({ done: payload.done, total: payload.total });
        }
      }),
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
            <p className="hint">Open a folder or a source from the sidebar, or press ⌘K.</p>
          )}
          {viewMode === "gallery" && <FilterBar />}
          {/* A streaming scan renders as soon as the first batch lands. */}
          {status === "loading" && count === 0 && <p className="hint">Loading…</p>}
          {status === "error" && <p className="error">{error}</p>}
          {status === "loaded" && count === 0 && <p className="hint">No images found.</p>}
          {count > 0 && viewMode === "gallery" && (
            galleryLayout === "map" ? (
              <MapGallery />
            ) : galleryLayout === "timeline" ? (
              <TimelineGallery />
            ) : galleryLayout === "darkroom" ? (
              <DarkroomGallery />
            ) : (
              // Scenes is the grid grouped into moments; one component.
              <GalleryGrid grouped={galleryLayout === "scenes"} />
            )
          )}
          {count > 0 && viewMode === "viewer" && <ImageViewer />}
        </main>
        <RightSidebar />
      </div>
      <StatusBar />
      <CommandPalette />
      <ImageContextMenu />
    </div>
  );
}

export default App;
