import { useLayoutEffect, useRef, useState } from "react";

import { ImageCanvas } from "../viewer/ImageCanvas";
import { Filmstrip } from "./Filmstrip";

const STRIP_FRACTION = 0.14;
const STRIP_MIN = 72;
const STRIP_MAX = 160;

/* From the whole pane, not the canvas: the canvas is what the strip leaves, so sizing off it oscillated. */
function filmstripHeight(paneHeight: number): number {
  return Math.round(Math.min(STRIP_MAX, Math.max(STRIP_MIN, paneHeight * STRIP_FRACTION)));
}

export function DarkroomGallery() {
  const ref = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPaneHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fallback before the first measure keeps the strip from flashing at full height on first paint.
  const height = filmstripHeight(paneHeight > 0 ? paneHeight : STRIP_MIN / STRIP_FRACTION);

  return (
    <div className="darkroom" ref={ref}>
      <ImageCanvas />
      <Filmstrip height={height} />
    </div>
  );
}
