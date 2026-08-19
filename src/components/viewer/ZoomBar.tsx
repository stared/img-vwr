import { parseNumber, Slider } from "../shell/Slider";
import { useAppStore } from "../../state/store";
import { fitToWindow, zoomLabel } from "./viewport";

// The track runs in log2 of the scale: halving and doubling are the same distance everywhere on it.
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
          // Landing on the fit mark becomes the named fit state, not a percentage that equals it only until the window resizes.
          if (Math.abs(v - fitAt) < 0.02) zoomFit();
          else zoom(2 ** v / view.scale);
        }}
      />
    </div>
  );
}
