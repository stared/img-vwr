import { useEffect, useRef } from "react";

import { developFrameUrl, fileUrl } from "../../ipc";
import { needsDevelopedFrame, previewEdge, useDevelopStore } from "../../state/develop";
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

  const session = useDevelopStore((s) => s.session);
  const requestRender = useDevelopStore((s) => s.requestRender);

  const containerRef = useRef<HTMLDivElement>(null);

  // Track canvas size in the store so zoom commands can center correctly,
  // and keep the develop preview rendered for roughly this many pixels.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      winResized({ width: el.clientWidth, height: el.clientHeight });
      requestRender(
        previewEdge(Math.max(el.clientWidth, el.clientHeight), window.devicePixelRatio),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [winResized, requestRender]);

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

  // Show the developed frame when the file cannot be displayed directly (raw)
  // or when an edit is applied; otherwise the original, which the webview
  // decodes itself and can zoom to full resolution.
  const developed = session !== null && session.path === entry.path && needsDevelopedFrame(session);
  const frame = developed ? session.frame : null;
  const src = frame !== null ? developFrameUrl(frame.token) : developed ? null : fileUrl(entry.path);

  // The viewport works in real image pixels, so "100%" means actual pixels
  // and fit is computed against the full 6048 px frame regardless of what is
  // on screen. A developed frame is a downscaled stand-in for that image, so
  // the transform has to undo the preview's own reduction — otherwise a
  // 24 MP raw renders at preview size, a twentieth of where it belongs.
  const previewScale =
    frame !== null && developed && frame.width > 0 ? session.info.width / frame.width : 1;

  if (src === null) {
    // A raw file whose first frame has not arrived: the decode takes a
    // couple of seconds and there is nothing meaningful to show meanwhile.
    return (
      <div ref={containerRef} className="viewer-canvas">
        <p className="hint">Developing {entry.name}…</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="viewer-canvas"
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        useAppStore.getState().setImageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <img
        key={entry.path}
        src={src}
        alt={entry.name}
        onLoad={(e) =>
          imageLoaded({
            // A developed frame is a downscaled preview; the viewport must
            // size itself to the real image so zoom and fit stay honest.
            width: developed ? session.info.width : e.currentTarget.naturalWidth,
            height: developed ? session.info.height : e.currentTarget.naturalHeight,
          })
        }
        draggable={false}
        style={{
          transform: view
            ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale * previewScale})`
            : undefined,
          visibility: view ? "visible" : "hidden",
        }}
      />
    </div>
  );
}
