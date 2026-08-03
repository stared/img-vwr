import { useEffect, useRef, useState } from "react";

import { developFrameUrl, fileUrl } from "../../ipc";
import {
  cropFromDrag,
  displayedSize,
  FULL_CROP,
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

interface Point2 {
  x: number;
  y: number;
}

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
  const img = useAppStore((s) => s.viewerImg);
  const gridlines = useDevelopStore((s) => s.gridlines);

  const cropping = useDevelopStore((s) => s.cropping);
  const setCropping = useDevelopStore((s) => s.setCropping);
  const setCrop = useDevelopStore((s) => s.setCrop);
  const [drag, setDrag] = useState<{ from: Point2; to: Point2 } | null>(null);

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

  // And develop them ahead, which is the expensive half. Only once this
  // image's own frame has arrived: the user is waiting on that one, and a
  // speculative render must never be what they are waiting behind. Next
  // before previous — forward is the way a shoot is usually walked.
  // Asked after every frame rather than once per image: the warm cache is
  // dropped whenever the viewport resizes, and this is what fills it again.
  // `prefetch` itself decides when there is room to do any of it.
  const prefetch = useDevelopStore((s) => s.prefetch);
  const settled = session?.path === entry?.path ? (session?.frame?.token ?? null) : null;
  useEffect(() => {
    if (index === null || settled === null) return;
    const near = [entries[index + 1], entries[index - 1]]
      .filter((e) => e !== undefined)
      .map((e) => e.path);
    prefetch(near);
  }, [entries, index, settled, prefetch]);

  // Zoomed in past what the preview resolves? Develop just the visible crop
  // at full sensor resolution, so 1:1 shows real detail instead of an
  // upscaled preview. Only the crop is developed, so it stays affordable.
  const frameForDetail = session?.frame ?? null;
  const detail = session?.detail ?? null;
  useEffect(() => {
    if (!session || !frameForDetail || !view || canvas.width === 0) return;
    const image = displayedSize(session.info, session.settings.crop);
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
    const size = displayedSize(session.info, session.settings.crop);
    const spanX = view.scale * size.width;
    const spanY = view.scale * size.height;
    if (spanX <= 0 || spanY <= 0) return;
    const x = (e.clientX - rect.left - view.tx) / spanX;
    const y = (e.clientY - rect.top - view.ty) / spanY;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    e.preventDefault();
    void pickWhiteBalanceAt(x, y);
  };

  /**
   * Dragging out a crop. Coordinates are the original frame's, because the
   * canvas shows the whole frame while cropping.
   */
  const pointOf = (e: React.PointerEvent): { x: number; y: number } | null => {
    if (!view || !img) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const spanX = view.scale * img.width;
    const spanY = view.scale * img.height;
    if (spanX <= 0 || spanY <= 0) return null;
    return {
      x: (e.clientX - rect.left - view.tx) / spanX,
      y: (e.clientY - rect.top - view.ty) / spanY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!cropping) return;
    const at = pointOf(e);
    if (!at) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: at, to: at });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!cropping || !drag) return;
    const at = pointOf(e);
    if (at) setDrag({ ...drag, to: at });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!cropping || !drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const moved = Math.abs(drag.to.x - drag.from.x) + Math.abs(drag.to.y - drag.from.y);
    // A click that went nowhere leaves crop mode instead of cropping to a
    // speck — the commonest way to say "never mind".
    if (moved < 0.01) setCropping(false);
    else setCrop(cropFromDrag(drag.from, drag.to, session?.settings.crop.angle ?? 0));
    setDrag(null);
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
  // While cropping the whole frame is on screen; otherwise it is the crop.
  const shown =
    developed && session
      ? displayedSize(session.info, cropping ? FULL_CROP : session.settings.crop)
      : null;
  const previewScale =
    frame !== null && shown !== null && frame.width > 0 ? shown.width / frame.width : 1;

  if (src === null) {
    // A raw file whose first frame has not arrived. The decode takes a couple
    // of seconds, and this is the one moment the filename belongs on the
    // image itself: the canvas is empty anyway, so it costs the photograph
    // nothing, and it is exactly when you want to know what is coming.
    return (
      <div ref={containerRef} className="viewer-canvas">
        <p className="canvas-waiting">
          <span className="canvas-waiting-name">{entry.name}</span>
          <span className="canvas-waiting-note">developing…</span>
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={[
        "viewer-canvas",
        session?.picking ? "picking" : "",
        cropping ? "cropping" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onWheel={handleWheel}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
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
            width: shown ? shown.width : e.currentTarget.naturalWidth,
            height: shown ? shown.height : e.currentTarget.naturalHeight,
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
      {/* While cropping, the rectangle: the one being dragged if there is a
          drag, otherwise the one already stored, so entering crop mode shows
          what you have rather than a blank frame. */}
      {cropping && view !== null && img !== null && (() => {
        const c = drag
          ? cropFromDrag(drag.from, drag.to, 0)
          : (session?.settings.crop ?? null);
        if (!c) return null;
        return (
          <div
            className="viewer-crop"
            style={{
              left: view.tx + c.x * img.width * view.scale,
              top: view.ty + c.y * img.height * view.scale,
              width: c.width * img.width * view.scale,
              height: c.height * img.height * view.scale,
            }}
          />
        );
      })()}
      {/* Thirds guides, laid over the image itself rather than the viewport,
          so they follow it as it pans and zooms — guides that stayed put on
          screen would be measuring the window, not the photograph. */}
      {gridlines && view !== null && img !== null && (
        <div
          className="viewer-guides"
          style={{
            left: view.tx,
            top: view.ty,
            width: img.width * view.scale,
            height: img.height * view.scale,
          }}
        >
          <span className="down" style={{ left: "33.333%" }} />
          <span className="down" style={{ left: "66.667%" }} />
          <span className="across" style={{ top: "33.333%" }} />
          <span className="across" style={{ top: "66.667%" }} />
        </div>
      )}
      {/* The 1:1 crop, laid exactly over the part of the preview it replaces.
          Drawn on top rather than instead of, so panning never blanks. */}
      {developed && detail !== null && view !== null && (
        <img
          className="viewer-detail"
          src={developFrameUrl(detail.token)}
          alt=""
          draggable={false}
          style={{
            left: view.tx + detail.regionX * (shown?.width ?? 0) * view.scale,
            top: view.ty + detail.regionY * (shown?.height ?? 0) * view.scale,
            width: detail.regionWidth * (shown?.width ?? 0) * view.scale,
            height: detail.regionHeight * (shown?.height ?? 0) * view.scale,
          }}
        />
      )}
    </div>
  );
}
