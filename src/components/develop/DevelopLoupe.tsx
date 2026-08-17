import { useEffect, useRef } from "react";

import { developFrameUrl } from "../../ipc";
import {
  displayedSize,
  loupeCovers,
  loupeRegion,
  useDevelopStore,
} from "../../state/develop";

/**
 * The loupe: true 100% pixels of one small region, at the top of the develop
 * column.
 *
 * In the column rather than floating over the photograph, because an inset
 * covers the very picture it is meant to help you judge — nothing is drawn
 * on the canvas at all. Aiming stays a drag on the photograph itself: the
 * pixels here follow the pointer, which is its own answer to "where is it
 * looking".
 */
export function DevelopLoupe() {
  const session = useDevelopStore((s) => s.session);
  const aimed = useDevelopStore((s) => s.loupeAt);
  const aimedByUser = useDevelopStore((s) => s.loupeAimedByUser);
  const aiming = useDevelopStore((s) => s.loupeAiming);
  const side = useDevelopStore((s) => s.loupeSide);
  const setLoupeSide = useDevelopStore((s) => s.setLoupeSide);
  const requestLoupe = useDevelopStore((s) => s.requestLoupe);

  // The box is as wide as the column, and the column's width is the
  // sidebar's business — so measure rather than assume, and share the
  // number through the store for the canvas's mark to agree with.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setLoupeSide(el.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [setLoupeSide]);

  // Ask for pixels when there is nothing to show — on opening, on a new
  // photograph, after an edit — and when the aim has been dragged past the
  // edge of the pixels in hand. Re-runs when pixels land, which is also what
  // retries a request that arrived while one was already in flight.
  const frame = session?.loupeFrame ?? null;
  const shown = session ? displayedSize(session.info, session.settings.crop) : null;
  const want =
    aimed && shown
      ? loupeRegion(aimed, shown, Math.round(side * devicePixelRatio))
      : null;
  const needs =
    session !== null &&
    (frame === null || want === null || !loupeCovers(frame.region, want));
  useEffect(() => {
    if (!needs) return;
    requestLoupe(Math.round(side * devicePixelRatio));
  }, [needs, aimed, side, requestLoupe]);

  return (
    <div ref={boxRef} className={aiming ? "develop-loupe aiming" : "develop-loupe"}>
      {frame && aimed && shown ? (
        /* Placed by where its pixels are rather than centred blindly: the
           window slides across a patch wider than itself, so the point under
           the centre is the point being aimed at even when the render for
           this exact position is still coming. */
        <img
          src={developFrameUrl(frame.frame.token)}
          alt=""
          draggable={false}
          style={{
            width: (frame.region.width * shown.width) / devicePixelRatio,
            height: (frame.region.height * shown.height) / devicePixelRatio,
            left: side / 2 - ((aimed.x - frame.region.x) * shown.width) / devicePixelRatio,
            top: side / 2 - ((aimed.y - frame.region.y) * shown.height) / devicePixelRatio,
          }}
        />
      ) : (
        <span className="develop-loupe-waiting" />
      )}
      {/* Everyone knows a loupe is 1:1; the only fact worth a word is that
          the aim was measured, not chosen. Aimed by hand, it says nothing. */}
      {!aimedByUser && <span className="develop-loupe-note">sharpest</span>}
    </div>
  );
}
