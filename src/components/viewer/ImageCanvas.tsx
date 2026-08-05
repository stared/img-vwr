import { useEffect, useRef, useState } from "react";

import { developFrameUrl, fileUrl } from "../../ipc";
import {
  cropFromDrag,
  displayedSize,
  FULL_CROP,
  loupeCovers,
  loupeRegion,
  needsDetail,
  needsDevelopedFrame,
  previewEdge,
  regionsDiffer,
  useDevelopStore,
  visibleRegion,
} from "../../state/develop";
import { useAppStore, useSelectedEntry, useVisibleEntries } from "../../state/store";
import { ImageCaption } from "./ImageCaption";

/**
 * The zoomable image surface: one photograph, panned and zoomed, showing the
 * developed frame whenever the file needs one.
 *
 * Shared by the full-screen viewer and the darkroom so there is exactly one
 * place that decides between an original and a developed frame, and exactly
 * one place that knows a preview frame stands in for a much larger image.
 */

const ZOOM_WHEEL_SENSITIVITY = 0.0022;

/**
 * The loupe's side in CSS pixels, for a canvas of this size.
 *
 * A share of the canvas rather than a fixed box, because the canvas is not a
 * fixed size: with both sidebars open the darkroom's is barely 280 px across,
 * and a 220 px loupe there covers most of the photograph it is meant to be
 * helping you judge. The bounds keep it useful at both extremes — below the
 * floor there is not enough of it to see an eyelash, above the ceiling it
 * stops being an inset.
 */
export function loupeEdge(canvas: { width: number; height: number }): number {
  const shorter = Math.min(canvas.width, canvas.height);
  return Math.round(Math.min(240, Math.max(96, shorter * 0.34)));
}

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
  const frameLost = useDevelopStore((s) => s.frameLost);
  const canvas = useAppStore((s) => s.viewerWin);
  const img = useAppStore((s) => s.viewerImg);
  const gridlines = useDevelopStore((s) => s.gridlines);

  const loupe = useDevelopStore((s) => s.loupe);
  const aimLoupe = useDevelopStore((s) => s.aimLoupe);
  const requestLoupe = useDevelopStore((s) => s.requestLoupe);
  const loupeFrame = session?.loupeFrame ?? null;

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

  // The loupe's own render: a small region at true 1:1, developed wider than
  // the window so the window can slide across it. Asked for when it has
  // nothing to show — on opening it, on a new photograph, after an edit — and
  // when the aim has been dragged past the edge of the pixels in hand.
  //
  // The effect re-runs when the pixels land, which is also what retries a
  // request that arrived while one was already in flight: the loupe can be
  // dragged far faster than it renders, and every intermediate position it
  // passed through is work nobody wants done.
  const loupeAimed = useDevelopStore((s) => s.loupeAt);
  const aimedByUser = useDevelopStore((s) => s.loupeAimedByUser);
  const loupeSide = loupeEdge(canvas);
  const loupeShown = session ? displayedSize(session.info, session.settings.crop) : null;
  const loupeWindow =
    loupeAimed && loupeShown
      ? loupeRegion(loupeAimed, loupeShown, Math.round(loupeSide * devicePixelRatio))
      : null;
  const needsLoupe =
    loupe &&
    session !== null &&
    (loupeFrame === null ||
      loupeWindow === null ||
      !loupeCovers(loupeFrame.region, loupeWindow));
  useEffect(() => {
    if (!needsLoupe) return;
    requestLoupe(Math.round(loupeSide * devicePixelRatio));
  }, [needsLoupe, loupeAimed, loupeSide, requestLoupe]);

  // And develop the neighbours ahead, which is the expensive half. Only once
  // this image's own frame has arrived: the user is waiting on that one, and
  // a speculative render must never be what they are waiting behind. Next
  // before previous — forward is the way a shoot is usually walked. Asked
  // after every frame rather than once per image, because the warm cache is
  // dropped whenever the viewport resizes and this is what fills it again;
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

  /** Where a pointer is, in the coordinates of the picture on screen (the
   *  crop), or null when it is off the photograph. */
  const shownPointOf = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    if (!session || !view) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const size = displayedSize(session.info, session.settings.crop);
    const spanX = view.scale * size.width;
    const spanY = view.scale * size.height;
    if (spanX <= 0 || spanY <= 0) return null;
    const x = (e.clientX - rect.left - view.tx) / spanX;
    const y = (e.clientY - rect.top - view.ty) / spanY;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  /** The eyedropper's neutral point: one deliberate click, one sample. */
  const handleClick = (e: React.MouseEvent) => {
    if (session?.picking !== true) return;
    const at = shownPointOf(e);
    if (!at) return;
    e.preventDefault();
    void pickWhiteBalanceAt(at.x, at.y);
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

  /**
   * Aiming the loupe: press to put it somewhere, drag to move it there.
   *
   * A drag rather than a click per look, because aiming a loupe is a search —
   * you push it around until the thing you wanted to check is under it — and
   * a click at a time makes that a guessing game with a round trip between
   * each guess. Held pixels and a margin (see `LOUPE_MARGIN`) are what let
   * the movement itself be immediate.
   */
  /* The drag itself lives in a ref and only its appearance in state. A
   * handler has to know whether a drag is running *now*, and React state is
   * whatever the last render saw — pointer events that arrive in one batch
   * (a synthetic sequence, or moves the browser coalesced) would all read the
   * value from before the drag began, and the release would be missed. */
  const aimingRef = useRef(false);
  const [aiming, setAiming] = useState(false);
  const setAimingNow = (on: boolean) => {
    aimingRef.current = on;
    setAiming(on);
  };
  const aimsLoupe = loupe && !cropping && session?.picking !== true;

  /* Pointer capture is what keeps a drag alive once it wanders off the canvas,
   * and it is deliberately never load-bearing: the state is set first and
   * released only if it was granted, so a drag still works where capture is
   * refused rather than stranding the loupe following an unpressed pointer. */
  const capture = (e: React.PointerEvent) => e.currentTarget.setPointerCapture(e.pointerId);
  const release = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (aimsLoupe) {
      const at = shownPointOf(e);
      if (!at) return;
      e.preventDefault();
      setAimingNow(true);
      aimLoupe(at);
      capture(e);
      return;
    }
    if (!cropping) return;
    const at = pointOf(e);
    if (!at) return;
    e.preventDefault();
    setDrag({ from: at, to: at });
    capture(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (aimingRef.current) {
      // Only while the button is really down. Without this, a capture that was
      // never granted leaves the loupe chasing the pointer for good.
      if ((e.buttons & 1) === 0) {
        setAimingNow(false);
        return;
      }
      const at = shownPointOf(e);
      if (at) aimLoupe(at);
      return;
    }
    if (!cropping || !drag) return;
    const at = pointOf(e);
    if (at) setDrag({ ...drag, to: at });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (aimingRef.current) {
      setAimingNow(false);
      release(e);
      return;
    }
    if (!cropping || !drag) return;
    release(e);
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
        // A developed frame whose token has been evicted; ask for it again
        // rather than leaving a black canvas nothing would ever repair.
        onError={() => {
          if (frame !== null) frameLost();
        }}
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
      {/* True 100% pixels of one small region, beside the fitted photograph
          rather than instead of it — so "is this sharp" and "is this a good
          picture" are one glance apart instead of a mode change apart. */}
      {loupe && (
        <div
          className={aiming ? "viewer-loupe aiming" : "viewer-loupe"}
          style={{ width: loupeSide, height: loupeSide }}
        >
          {loupeFrame && loupeAimed && loupeShown ? (
            /* Placed by where its pixels are rather than centred blindly: the
               window slides across a patch wider than itself, so the point
               under the crosshair is the point being aimed at even when the
               render for this exact position is still coming. */
            <img
              src={developFrameUrl(loupeFrame.frame.token)}
              alt=""
              draggable={false}
              style={{
                width: (loupeFrame.region.width * loupeShown.width) / devicePixelRatio,
                height: (loupeFrame.region.height * loupeShown.height) / devicePixelRatio,
                left:
                  loupeSide / 2 -
                  ((loupeAimed.x - loupeFrame.region.x) * loupeShown.width) / devicePixelRatio,
                top:
                  loupeSide / 2 -
                  ((loupeAimed.y - loupeFrame.region.y) * loupeShown.height) / devicePixelRatio,
              }}
            />
          ) : (
            <span className="viewer-loupe-waiting" />
          )}
          {/* Says where it is looking, not just that it is at 1:1 — which
              of the two is the interesting fact while stepping through. */}
          <span className="viewer-loupe-note">{aimedByUser ? "1:1" : "sharpest"}</span>
        </div>
      )}
      {/* And where on the photograph that is. Without it the inset is detail
          from nowhere in particular: you can see that something is sharp
          without being able to see what. It marks the window, not the wider
          patch developed around it — the window is what you are looking at. */}
      {loupe && loupeWindow !== null && loupeShown !== null && view !== null && (
        <div
          className={aiming ? "viewer-loupe-mark aiming" : "viewer-loupe-mark"}
          style={{
            left: view.tx + loupeWindow.x * loupeShown.width * view.scale,
            top: view.ty + loupeWindow.y * loupeShown.height * view.scale,
            width: loupeWindow.width * loupeShown.width * view.scale,
            height: loupeWindow.height * loupeShown.height * view.scale,
          }}
        />
      )}
      <ImageCaption entry={entry} />
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
