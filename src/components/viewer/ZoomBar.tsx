import { parseNumber, Slider } from "../shell/Slider";
import { useAppStore } from "../../state/store";
import { fitToWindow, zoomLabel } from "./viewport";

/**
 * The magnification, as a compact slider at the end of the top bar.
 *
 * A slider because zoom is a continuous quantity — the same track, marks
 * and readout as every other slider in the app, in the bar that is already
 * there rather than on a line of its own.
 *
 * It runs from fit to 1:1 and no further, because those are the ends that
 * mean anything: below fit is the photograph with room around it, beyond
 * 1:1 is invented pixels. The marks are the three magnifications a
 * photographer asks for by name — fit the longer edge (the whole
 * photograph), fit the shorter edge (no letterbox) and 1:1 (actual
 * pixels). Everything between is a place you dragged to, and the readout
 * says its number.
 *
 * The track runs in log2 of the scale, because zoom is multiplicative:
 * halving and doubling are the same distance everywhere on the track.
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
  // A photograph smaller than the window has nothing between fit and 1:1.
  if (fitAt >= 0) return null;

  return (
    <div className="zoom-bar">
      <Slider
        label="zoom"
        value={Math.log2(view.scale)}
        neutral={fitAt}
        min={fitAt}
        max={0}
        step={0.01}
        display={zoomLabel(view, fitted)}
        parse={(text) => {
          const percent = parseNumber(text.replace("%", ""));
          return percent === null || percent <= 0 ? null : Math.log2(percent / 100);
        }}
        ticks={[
          { at: fitAt, title: "fit the longer edge: the whole photograph" },
          ...(fill < 1
            ? [{ at: Math.log2(fill), title: "fit the shorter edge: no letterbox" }]
            : []),
          { at: 0, title: "1:1: actual pixels" },
        ]}
        layout="inline"
        title="From fit to actual pixels, log scale. The marks are fit the longer edge, fit the shorter edge, and 1:1; double-click comes back to fit. Keys: = and − zoom, ⌘0 fits, ⌘1 is 1:1."
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
