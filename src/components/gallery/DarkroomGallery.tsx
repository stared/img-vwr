import { useAppStore } from "../../state/store";
import { ImageCanvas } from "../viewer/ImageCanvas";
import { Filmstrip } from "./Filmstrip";

const STRIP_FRACTION = 0.16;
const STRIP_MIN = 72;
const STRIP_MAX = 160;

function filmstripHeight(paneHeight: number): number {
  return Math.round(Math.min(STRIP_MAX, Math.max(STRIP_MIN, paneHeight * STRIP_FRACTION)));
}

export function DarkroomGallery() {
  const paneHeight = useAppStore((s) => s.viewerWin.height);
  // Fallback before the first measure keeps the strip from flashing at full height on first paint.
  const height = filmstripHeight(paneHeight > 0 ? paneHeight : STRIP_MIN / STRIP_FRACTION);

  return (
    <div className="darkroom">
      <ImageCanvas />
      <Filmstrip height={height} />
    </div>
  );
}
