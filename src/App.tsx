import { useEffect, useRef } from "react";

import { CommandPalette } from "./components/shell/CommandPalette";
import { ExportDialog } from "./components/shell/ExportDialog";
import { FilterBar } from "./components/shell/FilterBar";
import { ImageContextMenu } from "./components/shell/ImageContextMenu";
import { DEFAULT_START_FOLDER } from "./config";
import { RightSidebar } from "./components/shell/RightSidebar";
import { ShortcutsOverlay } from "./components/shell/ShortcutsOverlay";
import { Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { useGlobalKeybindings } from "./components/shell/useGlobalKeybindings";
import { ImageViewer } from "./components/viewer/ImageViewer";
import { getView } from "./registry/views";
import { api, events, isLocal } from "./ipc";
import { executeCommand } from "./registry/commands";
import { useDevelopStore } from "./state/develop";
import { useSceneRefinement } from "./state/sceneRefinement";
import { restoreSession, startSessionPersistence } from "./state/session";
import { useAppStore, useSelectedEntry } from "./state/store";
import "./App.css";

/** Every file's EXIF, once per folder: timeline, map and date sorts read it without asking for it. */
function useFolderMeta() {
  const scope = useAppStore((s) => s.scope);
  const status = useAppStore((s) => s.status);
  const entries = useAppStore((s) => s.entries);
  const epoch = useAppStore((s) => s.epoch);
  const askedFor = useRef<number | null>(null);
  useEffect(() => {
    if (scope?.kind !== "folder" || status !== "loaded") return;
    if (askedFor.current === epoch) return;
    askedFor.current = epoch;
    const missing = entries.filter((e) => !useAppStore.getState().meta[e.path]).map((e) => e.path);
    if (missing.length > 0) void api.requestMeta(missing, epoch);
  }, [scope, status, entries, epoch]);
}

/** The session follows the lead selection in every view; panels only render it. */
function useDevelopSession() {
  const path = useSelectedEntry()?.path;
  const open = useDevelopStore((s) => s.open);
  const close = useDevelopStore((s) => s.close);
  useEffect(() => {
    if (path === undefined || !isLocal(path)) {
      close();
      return;
    }
    void open(path);
  }, [path, open, close]);
}

function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const count = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const galleryLayout = useAppStore((s) => s.galleryLayout);
  const GalleryView = getView(galleryLayout)?.component;

  useGlobalKeybindings();
  useSceneRefinement();
  useFolderMeta();
  useDevelopSession();

  useEffect(() => {
    const { status, openFolder } = useAppStore.getState();
    if (status === "idle" && !restoreSession() && DEFAULT_START_FOLDER) {
      void openFolder(DEFAULT_START_FOLDER, false);
    }
    return startSessionPersistence();
  }, []);

  const recentFolders = useAppStore((s) => s.recentFolders);
  useEffect(() => {
    void api.setRecentFolders(recentFolders);
  }, [recentFolders]);

  useEffect(() => {
    const { scanBatch, folderChanged, thumbReady, thumbFailed, dirCountReady, metaBatchReady } =
      useAppStore.getState();
    const unlisteners = [
      events.scanBatch.listen(({ payload }) =>
        scanBatch(payload.entries, payload.epoch, payload.done),
      ),
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
      events.menuAction.listen(({ payload }) => {
        if (payload.kind === "command") executeCommand(payload.id, { store: useAppStore });
        else void useAppStore.getState().openFolder(payload.path, false);
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
            <section className="welcome">
              <p className="welcome-eyebrow">IMAGE WORKSPACE</p>
              <h1>Browse photographs where they are.</h1>
              <p>Open a folder or choose a source. Originals are never modified.</p>
              <button onClick={() => useAppStore.getState().promptCommand("folder.open")}>
                Open Folder… <kbd>⌘O</kbd>
              </button>
              <span>Press <kbd>⌘K</kbd> for every command.</span>
            </section>
          )}
          {viewMode === "gallery" && <FilterBar />}
          {status === "loading" && count === 0 && <p className="hint">Loading…</p>}
          {status === "error" && <p className="error">{error}</p>}
          {status === "loaded" && count === 0 && <p className="hint">No images found.</p>}
          {count > 0 && viewMode === "gallery" && GalleryView && <GalleryView />}
          {count > 0 && viewMode === "viewer" && <ImageViewer />}
        </main>
        <RightSidebar />
      </div>
      <StatusBar />
      <CommandPalette />
      <ShortcutsOverlay />
      <ExportDialog />
      <ImageContextMenu />
    </div>
  );
}

export default App;
