import { useEffect, useRef, useState } from "react";

import { developFrameUrl, fileUrl } from "../../ipc";
import {
  ASPECT_CHOICES,
  drawn,
  HANDLES,
  moved,
  ratioOf,
  resized,
  type Handle,
} from "../../state/crop";
import {
  displayedSize,
  frameAspect,
  FULL_CROP,
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
  // The HDR panel's "check the frame the camera wrote": show the file at
  // this path rather than the fusion the path opens as.
  const original = useDevelopStore((s) => s.original);
  const requestRender = useDevelopStore((s) => s.requestRender);
  const requestDetail = useDevelopStore((s) => s.requestDetail);
  const clearDetail = useDevelopStore((s) => s.clearDetail);
  const pickWhiteBalanceAt = useDevelopStore((s) => s.pickWhiteBalanceAt);
  const frameLost = useDevelopStore((s) => s.frameLost);
  const canvas = useAppStore((s) => s.viewerWin);
  const img = useAppStore((s) => s.viewerImg);
  const gridlines = useDevelopStore((s) => s.gridlines);

  const aimLoupe = useDevelopStore((s) => s.aimLoupe);

  const cropping = useDevelopStore((s) => s.cropping);
  const setCropping = useDevelopStore((s) => s.setCropping);
  const setCrop = useDevelopStore((s) => s.setCrop);
  const cropChoice = useDevelopStore((s) => s.cropChoice);
  const cropPortrait = useDevelopStore((s) => s.cropPortrait);
  /**
   * What a press on the picture is doing to the crop.
   *
   * Three gestures, told apart by where the press landed rather than by a
   * mode: a handle resizes, the inside moves, the outside draws a new
   * rectangle. Nothing to arm, nothing to remember — the cursor over each
   * says which it is.
   */
  const [drag, setDrag] = useState<
    | { kind: "draw"; from: Point2; to: Point2 }
    | { kind: "move"; grab: Point2 }
    | { kind: "resize"; handle: Handle }
    | null
  >(null);

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

  // The loupe itself lives at the top of the develop column (DevelopLoupe);
  // the canvas keeps only the aiming gesture — a drag on the photograph is
  // where "show me this bit" belongs, and the loupe's pixels following the
  // pointer are their own answer to where it is looking.

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
   * Where a pointer is while cropping, as an offset from the crop's centre in
   * the *turned* frame — the space the rectangle is axis-aligned in, and so
   * the only space a corner drag means anything in.
   *
   * The canvas shows the whole frame while cropping, turned by the straighten
   * angle so the horizon is level and the rectangle can sit square on screen.
   * Screen coordinates are therefore already the turned frame's, minus the
   * crop's centre — no rotation happens here, which is exactly the point of
   * turning the picture rather than the rectangle.
   */
  const cropPointOf = (e: React.PointerEvent): Point2 | null => {
    if (!view || !img || !session) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const spanX = view.scale * img.width;
    const spanY = view.scale * img.height;
    if (spanX <= 0 || spanY <= 0) return null;
    const crop = session.settings.crop;
    return {
      x: (e.clientX - rect.left - view.tx) / spanX - (crop.x + crop.width / 2),
      y: (e.clientY - rect.top - view.ty) / spanY - (crop.y + crop.height / 2),
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
  /* The drag itself lives in a ref and only its appearance in the store. A
   * handler has to know whether a drag is running *now*, and store state is
   * whatever the last render saw — pointer events that arrive in one batch
   * (a synthetic sequence, or moves the browser coalesced) would all read the
   * value from before the drag began, and the release would be missed. In the
   * store rather than local state because the loupe brightening with the drag
   * sits in the develop column, not on this canvas. */
  const aimingRef = useRef(false);
  const setLoupeAiming = useDevelopStore((s) => s.setLoupeAiming);
  const setAimingNow = (on: boolean) => {
    aimingRef.current = on;
    setLoupeAiming(on);
  };
  const aimsLoupe = !cropping && session?.picking !== true;

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
    if (!cropping || !session) return;
    const at = cropPointOf(e);
    if (!at) return;
    e.preventDefault();
    const crop = session.settings.crop;
    const inside =
      Math.abs(at.x) <= crop.width / 2 && Math.abs(at.y) <= crop.height / 2;
    // Inside the rectangle the drag moves the picture within it; outside it
    // draws a new one. A handle press never reaches here — the handle's own
    // element takes it and says which one.
    setDrag(inside ? { kind: "move", grab: at } : { kind: "draw", from: at, to: at });
    capture(e);
  };

  /** A handle taken hold of: the resize runs on the canvas from here on, so
   * the pointer may leave the little square without the drag ending. */
  const handleGrab = (handle: Handle) => (e: React.PointerEvent) => {
    if (!cropping) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ kind: "resize", handle });
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
    if (!cropping || !drag || !session) return;
    const at = cropPointOf(e);
    if (!at) return;
    const crop = session.settings.crop;
    const aspect = frameAspect(session.info);
    if (drag.kind === "draw") {
      setDrag({ ...drag, to: at });
      return;
    }
    // Move and resize commit as they go: the rectangle is what the render is
    // about, and a crop that only appeared on release would be a guess until
    // then. Drawing waits, because a half-finished rectangle is not a crop.
    if (drag.kind === "move") {
      // Measured against the crop as it stands, not as it was pressed: every
      // move puts the grabbed point back under the pointer, so the next
      // event's offset is again relative to the same place on the rectangle.
      // Reading from a remembered start would double every delta.
      setCrop(moved(crop, at.x - drag.grab.x, at.y - drag.grab.y, aspect));
    } else {
      const choice = ASPECT_CHOICES.find((c) => c.id === cropChoice) ?? null;
      const ratio = choice ? ratioOf(choice, aspect, cropPortrait) : null;
      setCrop(resized(crop, drag.handle, at, aspect, ratio));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (aimingRef.current) {
      setAimingNow(false);
      release(e);
      return;
    }
    if (!cropping || !drag) return;
    release(e);
    if (drag.kind === "draw" && session) {
      const went = Math.abs(drag.to.x - drag.from.x) + Math.abs(drag.to.y - drag.from.y);
      // A click that went nowhere leaves crop mode instead of cropping to a
      // speck — the commonest way to say "never mind".
      if (went < 0.01) setCropping(false);
      else setCrop(drawn(session.settings.crop, drag.from, drag.to, frameAspect(session.info)));
    }
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
  // decodes itself and can zoom to full resolution. The "check the frame
  // the camera wrote" look overrides towards the file: the path opens as a
  // fusion, but the file at it is a real JPEG worth looking at.
  const developed =
    session !== null &&
    session.path === entry.path &&
    needsDevelopedFrame(session) &&
    original !== entry.path;
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

  /**
   * The turn that makes cropping judgeable: the photograph rotates under a
   * rectangle that stays square on screen.
   *
   * The stored rectangle is axis-aligned in a frame turned by `angle`, so
   * showing the frame turned by the same amount puts the two in the same
   * space — the rectangle can be drawn as an ordinary box, dragged with
   * ordinary handles, and what you see inside it is what will be rendered.
   * Turning the rectangle instead would leave the horizon crooked and the
   * rectangle crooked with it, and you would have to tilt your head to judge
   * whether you had got it straight.
   *
   * About the crop's own centre, in percentages of the element, so it works
   * whatever size preview happens to be standing in for the frame.
   */
  const turning = cropping && session !== null && session.settings.crop.angle !== 0;
  const turn = turning && session
    ? (() => {
        const crop = session.settings.crop;
        const [cx, cy] = [(crop.x + crop.width / 2) * 100, (crop.y + crop.height / 2) * 100];
        return ` translate(${cx}%, ${cy}%) rotate(${-crop.angle}deg) translate(${-cx}%, ${-cy}%)`;
      })()
    : "";

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
            ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale * previewScale})${turn}`
            : undefined,
          visibility: view ? "visible" : "hidden",
        }}
      />
      {/* While cropping, the rectangle: the one being dragged out if there is
          a drag, otherwise the one already stored, so entering crop mode shows
          what you have rather than a blank frame.

          It is always square on screen, because the picture behind it is the
          thing that turns. Its handles are what a crop is adjusted by — a
          rectangle you can only ever re-draw is one where nudging an edge
          means starting again. */}
      {cropping && view !== null && img !== null && session !== null && (() => {
        const c =
          drag?.kind === "draw"
            ? drawn(session.settings.crop, drag.from, drag.to, frameAspect(session.info))
            : session.settings.crop;
        const box = {
          left: view.tx + c.x * img.width * view.scale,
          top: view.ty + c.y * img.height * view.scale,
          width: c.width * img.width * view.scale,
          height: c.height * img.height * view.scale,
        };
        return (
          <div className="viewer-crop" style={box}>
            {/* Thirds inside the crop, which is where a composition is
                judged — the frame they used to describe is half thrown away
                by the time you are here. */}
            <span className="viewer-crop-third down" style={{ left: "33.333%" }} />
            <span className="viewer-crop-third down" style={{ left: "66.667%" }} />
            <span className="viewer-crop-third across" style={{ top: "33.333%" }} />
            <span className="viewer-crop-third across" style={{ top: "66.667%" }} />
            {HANDLES.map((handle) => (
              <span
                key={handle}
                className={`viewer-crop-handle ${handle}`}
                onPointerDown={handleGrab(handle)}
              />
            ))}
          </div>
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
      {/* Pixels on their way, said in the corner of the picture. Only that:
          the magnification is the zoom slider's readout, and a second copy
          of the number would be one more thing saying the same thing. */}
      {developed && session !== null && (session.rendering || session.detailing) && (
        <span className="canvas-marker">rendering…</span>
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
