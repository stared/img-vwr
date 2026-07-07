import { useEffect, useRef } from "react";

import { fileUrl } from "../../ipc";
import { useAppStore, useVisibleEntries } from "../../state/store";

const ZOOM_WHEEL_SENSITIVITY = 0.0022;

export function ImageViewer() {
  const entries = useVisibleEntries();
  const index = useAppStore((s) => s.selectedIndex);
  const view = useAppStore((s) => s.viewerView);
  const imageLoaded = useAppStore((s) => s.viewerImageLoaded);
  const winResized = useAppStore((s) => s.viewerWinResized);
  const zoom = useAppStore((s) => s.viewerZoom);
  const pan = useAppStore((s) => s.viewerPan);
  const entry = entries[index];

  const containerRef = useRef<HTMLDivElement>(null);

  // Track canvas size in the store so zoom commands can center correctly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      winResized({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    winResized({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [winResized]);

  // Preload neighbours so arrow-key navigation has no white flash.
  useEffect(() => {
    for (const neighbour of [entries[index - 1], entries[index + 1]]) {
      if (neighbour) new Image().src = fileUrl(neighbour.path);
    }
  }, [entries, index]);

  const handleWheel = (e: React.WheelEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel; anchor the zoom under the cursor.
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      zoom(Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY), cursor);
    } else {
      pan(-e.deltaX, -e.deltaY);
    }
  };

  const handleDoubleClick = () => {
    const { viewerFitted, viewerZoomActual, viewerZoomFit } = useAppStore.getState();
    if (viewerFitted) viewerZoomActual();
    else viewerZoomFit();
  };

  if (!entry) return null;

  return (
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
        onLoad={(e) =>
          imageLoaded({
            width: e.currentTarget.naturalWidth,
            height: e.currentTarget.naturalHeight,
          })
        }
        draggable={false}
        style={{
          transform: view ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` : undefined,
          visibility: view ? "visible" : "hidden",
        }}
      />
    </div>
  );
}
