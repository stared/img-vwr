import { parseNumber, Slider } from "../shell/Slider";
import { useAppStore } from "../../state/store";
import { fitToWindow, MAX_SCALE, MIN_SCALE, zoomLabel } from "./viewport";

/**
 * The magnification, as a slider above the photograph.
 *
 * A slider because zoom is a continuous quantity, and above the picture
 * because that is where the zooming happens — the same track, marks and
 * readout as every other slider in the app. The marks are the three
 * magnifications a photographer asks for by name: fit (the whole
 * photograph), fill (the window, edge to edge) and 1:1 (actual pixels).
 * Everything else is a place you dragged to, and the readout says its
 * number.
 *
 * The track runs in log2 of the scale, because zoom is multiplicative:
 * halving and doubling are the same distance everywhere on the track, where
 * a linear track would spend nearly all of itself past 1:1.
 */
export function ZoomBar() {
  const view = useAppStore((s) => s.viewerView);
  const img = useAppStore((s) => s.viewerImg);
  const win = useAppStore((s) => s.viewerWin);
  const fitted = useAppStore((s) => s.viewerFitted);
  const zoom = useAppStore((s) => s.viewerZoom);
  const zoomFit = useAppStore((s) => s.viewerZoomFit);

  if (!view || !img || img.width === 0 || win.width === 0) return null;

  const fit = fitToWindow(img, win).scale;
  const fill = Math.max(win.width / img.width, win.height / img.height);
  const fitAt = Math.log2(fit);

  return (
    <div className="zoom-bar">
      <Slider
        label="zoom"
        value={Math.log2(view.scale)}
        neutral={fitAt}
        min={Math.log2(MIN_SCALE)}
        max={Math.log2(MAX_SCALE)}
        step={0.01}
        display={zoomLabel(view, fitted)}
        parse={(text) => {
          const percent = parseNumber(text.replace("%", ""));
          return percent === null || percent <= 0 ? null : Math.log2(percent / 100);
        }}
        ticks={[
          { at: fitAt, title: "fit: the whole photograph" },
          { at: Math.log2(fill), title: "fill: the window, edge to edge" },
          { at: 0, title: "1:1: actual pixels" },
        ]}
        layout="inline"
        title="Log scale: doubling is the same distance everywhere. The marks are fit, fill and actual pixels; double-click comes back to fit."
        onChange={(v) => {
          // Landing on the fit mark is fit, the named state — not a
          // percentage that happens to equal it until the window resizes.
          if (Math.abs(v - fitAt) < 0.02) zoomFit();
          else zoom(2 ** v / view.scale);
        }}
      />
    </div>
  );
}
