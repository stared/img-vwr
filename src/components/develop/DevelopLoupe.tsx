import { useEffect, useRef } from "react";

import { developFrameUrl } from "../../ipc";
import {
  displayedSize,
  loupeCovers,
  loupeRegion,
  useDevelopStore,
} from "../../state/develop";

export function DevelopLoupe() {
  const session = useDevelopStore((s) => s.session);
  const aimed = useDevelopStore((s) => s.loupeAt);
  const aimedByUser = useDevelopStore((s) => s.loupeAimedByUser);
  const aiming = useDevelopStore((s) => s.loupeAiming);
  const side = useDevelopStore((s) => s.loupeSide);
  const setLoupeSide = useDevelopStore((s) => s.setLoupeSide);
  const requestLoupe = useDevelopStore((s) => s.requestLoupe);

  // Measured width goes through the store so the canvas aim mark uses the same number.
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

  // Effect re-runs when new pixels land, which retries a request made while one was already in flight.
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
        /* The patch is wider than the box; offsetting by its region keeps the aimed point under the centre while a fresh render is in flight. */
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
      {!aimedByUser && <span className="develop-loupe-note">sharpest</span>}
    </div>
  );
}
