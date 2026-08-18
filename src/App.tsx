import { useEffect, useRef } from "react";

import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { DarkroomGallery } from "./components/gallery/DarkroomGallery";
import { MapGallery } from "./components/gallery/MapGallery";
import { MosaicGallery } from "./components/gallery/MosaicGallery";
import { TimelineGallery } from "./components/gallery/TimelineGallery";
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
import { developSetFusions, events, requestMeta, type FusionRecipe } from "./ipc";
import { useDevelopStore } from "./state/develop";
import { fusionMap } from "./state/hdr";
import { useSceneRefinement } from "./state/sceneRefinement";
import { restoreSession, startSessionPersistence } from "./state/session";
import { hdrOf, useAppStore } from "./state/store";
import "./App.css";

/**
 * HDR sets are photographs, so noticing them is not a view's job — it is
 * the collection's. As the folder's EXIF streams in, detection runs over
 * it, and each set's face path is registered with the develop service as
 * "this path opens as the fusion of these frames". From then on the merge
 * simply *is* what that photograph looks like — in the viewer, in the
 * darkroom, in an export — with no file written anywhere until an export
 * writes one.
 */
function useHdrDetection() {
  const scope = useAppStore((s) => s.scope);
  const status = useAppStore((s) => s.status);
  const entries = useAppStore((s) => s.entries);
  const epoch = useAppStore((s) => s.epoch);
  // Identity-stable: a meta batch that changed no set keeps the old array.
  const sets = useAppStore((s) => (s.scope?.kind === "folder" ? hdrOf(s).sets : null));
  const methods = useAppStore((s) => s.hdrMethod);

  // Detection wants every file's exposure, not only the EXIF the panels on
  // screen happen to have asked about. Once per folder, in the background.
  const askedFor = useRef<number | null>(null);
  useEffect(() => {
    if (scope?.kind !== "folder" || status !== "loaded") return;
    if (askedFor.current === epoch) return;
    askedFor.current = epoch;
    const missing = entries.filter((e) => !useAppStore.getState().meta[e.path]).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [scope, status, entries, epoch]);

  // What was last told to the develop service, so an unchanged answer costs
  // nothing and a changed one replaces the whole map at once.
  const registered = useRef("");
  const previous = useRef<Record<string, FusionRecipe>>({});
  useEffect(() => {
    const fusions = Object.fromEntries(
      Object.entries(sets === null ? {} : fusionMap(sets)).map(([face, frames]) => [
        face,
        { frames, method: methods[face] ?? ("fusion" as const) },
      ]),
    );
    const signature = JSON.stringify(fusions);
    if (signature === registered.current) return;
    registered.current = signature;
    const before = previous.current;
    previous.current = fusions;
    void developSetFusions(fusions).then(() => {
      // Detection usually lands *after* the user is already looking at a
      // frame: the face opened as a plain JPEG seconds ago, and nothing else
      // would ever tell that session its path now means the fusion.
      const changed = [...new Set([...Object.keys(before), ...Object.keys(fusions)])].filter(
        (path) => JSON.stringify(before[path]) !== JSON.stringify(fusions[path]),
      );
      if (changed.length > 0) useDevelopStore.getState().dropStale(changed);
    });
  }, [sets, methods]);
}

function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const count = useAppStore((s) => s.entries.length);
  const viewMode = useAppStore((s) => s.viewMode);
  const galleryLayout = useAppStore((s) => s.galleryLayout);

  useGlobalKeybindings();
  useSceneRefinement();
  useHdrDetection();

  // Start where the last sitting ended — same folder, view and filters —
  // and only failing that, in the configured default folder (a testing
  // convenience; see config.ts). Then keep the saved session current.
  useEffect(() => {
    const { status, openFolder } = useAppStore.getState();
    if (status === "idle" && !restoreSession() && DEFAULT_START_FOLDER) {
      void openFolder(DEFAULT_START_FOLDER, false);
    }
    return startSessionPersistence();
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
            ) : galleryLayout === "mosaic" ? (
              <MosaicGallery />
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
      <ShortcutsOverlay />
      <ExportDialog />
      <ImageContextMenu />
    </div>
  );
}

export default App;
