import { useEffect, useRef } from "react";

import { developFrameUrl, fileUrl } from "../../ipc";
import {
  needsDetail,
  needsDevelopedFrame,
  previewEdge,
  regionsDiffer,
  useDevelopStore,
  visibleRegion,
} from "../../state/develop";
import { useAppStore, useSelectedEntry, useVisibleEntries } from "../../state/store";

/**
 * The zoomable image surface: one photograph, panned and zoomed, showing the
 * developed frame whenever the file needs one.
 *
 * Shared by the full-screen viewer and the darkroom so there is exactly one
 * place that decides between an original and a developed frame, and exactly
 * one place that knows a preview frame stands in for a much larger image.
 */

const ZOOM_WHEEL_SENSITIVITY = 0.0022;

export function ImageCanvas() {
  const entries = useVisibleEntries();
  const index = useAppStore((s) => s.selectedIndex);
  const view = useAppStore((s) => s.viewerView);
  const imageLoaded = useAppStore((s) => s.viewerImageLoaded);
  const winResized = useAppStore((s) => s.viewerWinResized);
  const zoom = useAppStore((s) => s.viewerZoom);
  const pan = useAppStore((s) => s.viewerPan);
  const entry = useSelectedEntry();

  const session = useDevelopStore((s) => s.session);
  const requestRender = useDevelopStore((s) => s.requestRender);
  const requestDetail = useDevelopStore((s) => s.requestDetail);
  const clearDetail = useDevelopStore((s) => s.clearDetail);
  const pickWhiteBalanceAt = useDevelopStore((s) => s.pickWhiteBalanceAt);
  const canvas = useAppStore((s) => s.viewerWin);

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
    if (index === null) return;
    for (const neighbour of [entries[index - 1], entries[index + 1]]) {
      if (neighbour) new Image().src = fileUrl(neighbour.path);
    }
  }, [entries, index]);

  // Zoomed in past what the preview resolves? Develop just the visible crop
  // at full sensor resolution, so 1:1 shows real detail instead of an
  // upscaled preview. Only the crop is developed, so it stays affordable.
  const frameForDetail = session?.frame ?? null;
  const detail = session?.detail ?? null;
  useEffect(() => {
    if (!session || !frameForDetail || !view || canvas.width === 0) return;
    const image = { width: session.info.width, height: session.info.height };
    if (!needsDetail(view, frameForDetail, image)) {
      clearDetail();
      return;
    }
    const region = visibleRegion(view, image, canvas);
    const already = detail
      ? {
          x: detail.regionX,
          y: detail.regionY,
          width: detail.regionWidth,
          height: detail.regionHeight,
        }
      : null;
    if (already && !regionsDiffer(region, already)) return;
    requestDetail(region, Math.round(Math.max(canvas.width, canvas.height) * devicePixelRatio));
  }, [session, frameForDetail, detail, view, canvas, requestDetail, clearDetail]);

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

  /** While the eyedropper is armed, a click says "this is grey". */
  const handleClick = (e: React.MouseEvent) => {
    if (!session?.picking || !view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const spanX = view.scale * session.info.width;
    const spanY = view.scale * session.info.height;
    if (spanX <= 0 || spanY <= 0) return;
    const x = (e.clientX - rect.left - view.tx) / spanX;
    const y = (e.clientY - rect.top - view.ty) / spanY;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    e.preventDefault();
    void pickWhiteBalanceAt(x, y);
  };

  const handleDoubleClick = () => {
    const { viewerFitted, viewerZoomActual, viewerZoomFit } = useAppStore.getState();
    if (viewerFitted) viewerZoomActual();
    else viewerZoomFit();
  };

  if (!entry) {
    return (
      <div ref={containerRef} className="viewer-canvas">
        <p className="hint">No image selected.</p>
      </div>
    );
  }

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
      className={session?.picking ? "viewer-canvas picking" : "viewer-canvas"}
      onWheel={handleWheel}
      onClick={handleClick}
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
      {/* The 1:1 crop, laid exactly over the part of the preview it replaces.
          Drawn on top rather than instead of, so panning never blanks. */}
      {developed && detail !== null && view !== null && (
        <img
          className="viewer-detail"
          src={developFrameUrl(detail.token)}
          alt=""
          draggable={false}
          style={{
            left: view.tx + detail.regionX * session.info.width * view.scale,
            top: view.ty + detail.regionY * session.info.height * view.scale,
            width: detail.regionWidth * session.info.width * view.scale,
            height: detail.regionHeight * session.info.height * view.scale,
          }}
        />
      )}
    </div>
  );
}
