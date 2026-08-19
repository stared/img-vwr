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
  // When set, show the file at this path rather than the fusion the path opens as.
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
  const [drag, setDrag] = useState<
    | { kind: "draw"; from: Point2; to: Point2 }
    | { kind: "move"; grab: Point2 }
    | { kind: "resize"; handle: Handle }
    | null
  >(null);

  const containerRef = useRef<HTMLDivElement>(null);

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

  // Prefetch only after this image's own frame settles, and after every frame — resizes drop the warm cache.
  const prefetch = useDevelopStore((s) => s.prefetch);
  const settled = session?.path === entry?.path ? (session?.frame?.token ?? null) : null;
  useEffect(() => {
    if (index === null || settled === null) return;
    const near = [entries[index + 1], entries[index - 1]]
      .filter((e) => e !== undefined)
      .map((e) => e.path);
    prefetch(near);
  }, [entries, index, settled, prefetch]);

  // Past what the preview resolves, develop just the visible region at full sensor resolution.
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

  /** Pointer position in shown-picture (crop) coordinates, or null off the photograph. */
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

  const handleClick = (e: React.MouseEvent) => {
    if (session?.picking !== true) return;
    const at = shownPointOf(e);
    if (!at) return;
    e.preventDefault();
    void pickWhiteBalanceAt(at.x, at.y);
  };

  /** Pointer as an offset from the crop's centre in the turned frame; the canvas shows the frame turned, so screen coordinates already are that space. */
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

  // A ref: batched pointer events must read whether the drag runs now; the store copy only styles the loupe.
  const aimingRef = useRef(false);
  const setLoupeAiming = useDevelopStore((s) => s.setLoupeAiming);
  const setAimingNow = (on: boolean) => {
    aimingRef.current = on;
    setLoupeAiming(on);
  };
  const aimsLoupe = !cropping && session?.picking !== true;

  // Capture is never load-bearing: state is set first and released only if granted, so a refused capture still drags.
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
    // A handle press never reaches here — the handle's own element takes it (handleGrab).
    setDrag(inside ? { kind: "move", grab: at } : { kind: "draw", from: at, to: at });
    capture(e);
  };

  const handleGrab = (handle: Handle) => (e: React.PointerEvent) => {
    if (!cropping) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ kind: "resize", handle });
    capture(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (aimingRef.current) {
      // Without the buttons check, a capture that was never granted leaves the loupe chasing the pointer for good.
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
    if (drag.kind === "move") {
      // Offset is against the crop as it stands — each move re-centres the grab, so a remembered start would double every delta.
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
      // A click that went nowhere leaves crop mode instead of cropping to a speck.
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

  const developed =
    session !== null &&
    session.path === entry.path &&
    needsDevelopedFrame(session) &&
    original !== entry.path;
  const frame = developed ? session.frame : null;
  const src = frame !== null ? developFrameUrl(frame.token) : developed ? null : fileUrl(entry.path);

  // The viewport works in real image pixels; the transform must undo the preview frame's own downscale.
  const shown =
    developed && session
      ? displayedSize(session.info, cropping ? FULL_CROP : session.settings.crop)
      : null;
  const previewScale =
    frame !== null && shown !== null && frame.width > 0 ? shown.width / frame.width : 1;

  // The stored rectangle is axis-aligned in the frame turned by `angle`, so the picture turns about the crop's centre and the box stays square on screen.
  const turning = cropping && session !== null && session.settings.crop.angle !== 0;
  const turn = turning && session
    ? (() => {
        const crop = session.settings.crop;
        const [cx, cy] = [(crop.x + crop.width / 2) * 100, (crop.y + crop.height / 2) * 100];
        return ` translate(${cx}%, ${cy}%) rotate(${-crop.angle}deg) translate(${-cx}%, ${-cy}%)`;
      })()
    : "";

  if (src === null) {
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
            // Report the real image size, not the downscaled preview's.
            width: shown ? shown.width : e.currentTarget.naturalWidth,
            height: shown ? shown.height : e.currentTarget.naturalHeight,
          })
        }
        // An evicted frame token errors; ask again rather than leave a black canvas.
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
      {developed && session !== null && (session.rendering || session.detailing) && (
        <span className="canvas-marker">rendering…</span>
      )}
      <ImageCaption entry={entry} />
      {/* The 1:1 detail is drawn on top of the preview, not instead of it, so panning never blanks. */}
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
