import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { commands } from "../../ipc/bindings";
import type { ImageMeta } from "../../ipc/bindings";
import { fileUrl } from "../../ipc";
import { useAppStore } from "../../state/store";
import type { Size, Viewport } from "./viewport";
import { actualSize, clampPan, fitToWindow, panBy, zoomAtPoint } from "./viewport";

const ZOOM_WHEEL_SENSITIVITY = 0.0022;

export function ImageViewer() {
  const entries = useAppStore((s) => s.entries);
  const index = useAppStore((s) => s.selectedIndex);
  const navigate = useAppStore((s) => s.navigate);
  const closeViewer = useAppStore((s) => s.closeViewer);
  const entry = entries[index];

  const containerRef = useRef<HTMLDivElement>(null);
  const [imgSize, setImgSize] = useState<Size | null>(null);
  const [view, setView] = useState<Viewport | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const fitted = useRef(true);

  const winSize = useCallback((): Size => {
    const el = containerRef.current;
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
  }, []);

  // New image: reset to fit once its natural size is known.
  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setImgSize(size);
    setView(fitToWindow(size, winSize()));
    fitted.current = true;
  };

  useEffect(() => {
    setImgSize(null);
    setView(null);
    setMeta(null);
    if (entry) {
      void commands.getMetadata(entry.path).then((r) => {
        if (r.status === "ok") setMeta(r.data);
      });
    }
  }, [entry]);

  // Preload neighbours so arrow-key navigation has no white flash.
  useEffect(() => {
    for (const neighbour of [entries[index - 1], entries[index + 1]]) {
      if (neighbour) new Image().src = fileUrl(neighbour.path);
    }
  }, [entries, index]);

  // Keep the fit on window resize (only while the user hasn't zoomed).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (fitted.current && imgSize) setView(fitToWindow(imgSize, winSize()));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [imgSize, winSize]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") navigate(1);
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "Escape") closeViewer();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, closeViewer]);

  const handleWheel = (e: React.WheelEvent) => {
    if (!view || !imgSize) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel; anchor the zoom under the cursor.
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY);
      setView(clampPan(zoomAtPoint(view, cursor, factor), imgSize, winSize()));
      fitted.current = false;
    } else {
      setView(clampPan(panBy(view, -e.deltaX, -e.deltaY), imgSize, winSize()));
      fitted.current = false;
    }
  };

  const handleDoubleClick = () => {
    if (!imgSize) return;
    const next = fitted.current ? actualSize(imgSize, winSize()) : fitToWindow(imgSize, winSize());
    setView(next);
    fitted.current = !fitted.current;
  };

  const transform = useMemo(
    () => (view ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` : undefined),
    [view],
  );

  if (!entry) return null;

  return (
    <div className="viewer">
      <div
        ref={containerRef}
        className="viewer-canvas"
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      >
        <img
          key={entry.path}
          src={fileUrl(entry.path)}
          alt={entry.name}
          onLoad={handleLoad}
          draggable={false}
          style={{ transform, visibility: view ? "visible" : "hidden" }}
        />
      </div>
      <footer className="viewer-status">
        <span className="file-name">{entry.name}</span>
        <span>
          {index + 1} / {entries.length}
        </span>
        {meta?.width != null && meta.height != null && (
          <span>
            {meta.width}×{meta.height}
          </span>
        )}
        {meta?.exif?.camera && <span>{meta.exif.camera}</span>}
        {view && <span>{Math.round(view.scale * 100)}%</span>}
      </footer>
    </div>
  );
}
