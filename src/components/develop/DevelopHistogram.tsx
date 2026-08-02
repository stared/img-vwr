import { useEffect, useRef } from "react";

import type { Histogram } from "../../ipc";

/**
 * Histogram of the developed pixels — the ones on screen, so what it shows
 * clipping is what the user would actually lose.
 *
 * The three channels are drawn as additive fills: where they overlap the
 * result is grey, which is the standard reading and makes a colour cast
 * visible as a coloured fringe at one end.
 */

const WIDTH = 224;
const HEIGHT = 80;

export function DevelopHistogram({ histogram }: { histogram: Histogram | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (!histogram) return;

    // Scale to the tallest bin across all channels, ignoring the two ends:
    // a large flat black or white area would otherwise dwarf everything in
    // between and flatten the shape that matters.
    const interior = (bins: number[]) => bins.slice(1, 255);
    const max = Math.max(
      1,
      ...interior(histogram.red),
      ...interior(histogram.green),
      ...interior(histogram.blue),
    );

    ctx.globalCompositeOperation = "lighter";
    const channels: [number[], string][] = [
      [histogram.red, "rgba(220, 60, 60, 0.75)"],
      [histogram.green, "rgba(60, 210, 90, 0.75)"],
      [histogram.blue, "rgba(70, 120, 240, 0.75)"],
    ];
    for (const [bins, colour] of channels) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(0, HEIGHT);
      bins.forEach((count, bin) => {
        const x = (bin / 255) * WIDTH;
        const y = HEIGHT - Math.min(1, count / max) * (HEIGHT - 2);
        ctx.lineTo(x, y);
      });
      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [histogram]);

  const total =
    histogram === null
      ? 0
      : histogram.luma.reduce((sum, count) => sum + count, 0);
  const percent = (count: number) => ((count / Math.max(1, total)) * 100).toFixed(1);

  return (
    <div className="develop-histogram">
      <canvas ref={ref} className="info-canvas" width={WIDTH} height={HEIGHT} />
      {histogram !== null && (
        <div className="develop-clipping">
          <span title="Pixels crushed to pure black">
            ▼ {percent(histogram.clippedShadows)}%
          </span>
          <span title="Pixels blown to pure white">
            ▲ {percent(histogram.clippedHighlights)}%
          </span>
        </div>
      )}
    </div>
  );
}
