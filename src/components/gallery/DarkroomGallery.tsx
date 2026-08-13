import { useAppStore } from "../../state/store";
import { ImageCanvas } from "../viewer/ImageCanvas";
import { ZoomBar } from "../viewer/ZoomBar";
import { Filmstrip } from "./Filmstrip";

/**
 * The darkroom: one photograph large, the sequence beneath it, and the
 * develop panel to the right (the right sidebar, which is already there).
 *
 * A gallery layout rather than a separate mode, because it renders the same
 * query result as the grid does — just one image at a time with the rest
 * within reach.
 */

/** Filmstrip height as a share of the pane, so it scales with the window
 * instead of being a fixed band that dominates a short one. */
const STRIP_FRACTION = 0.16;
const STRIP_MIN = 72;
const STRIP_MAX = 160;

export function filmstripHeight(paneHeight: number): number {
  return Math.round(Math.min(STRIP_MAX, Math.max(STRIP_MIN, paneHeight * STRIP_FRACTION)));
}

export function DarkroomGallery() {
  const paneHeight = useAppStore((s) => s.viewerWin.height);
  // Before the canvas has measured itself, the minimum keeps the strip from
  // flashing at full height on first paint.
  const height = filmstripHeight(paneHeight > 0 ? paneHeight : STRIP_MIN / STRIP_FRACTION);

  return (
    <div className="darkroom">
      <ZoomBar />
      <ImageCanvas />
      <Filmstrip height={height} />
    </div>
  );
}
