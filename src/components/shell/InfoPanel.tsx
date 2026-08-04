import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ImageStats } from "../../ipc";
import { formatAperture, formatShutter } from "../../facts/builtin";
import { imageStats, labelsSetStars } from "../../ipc";
import { formatBytes } from "../../state/stats";
import { useAppStore, useSelectedEntry } from "../../state/store";

/**
 * Per-image inspector: file facts, EXIF, labels, then pixel statistics —
 * a value histogram (luma filled, RGB lines) and a Maxwell color triangle
 * (pixel density over barycentric RGB). Stats come from Rust, computed on
 * the cached thumbnail, and follow the selection with a short debounce.
 */

const STATS_DEBOUNCE_MS = 150;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="stats-section">
      <button className="stats-section-header" onClick={() => setOpen(!open)}>
        <span className="stats-disclosure">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && children}
    </section>
  );
}

/**
 * The rating, set by clicking.
 *
 * The keys (1-5, 0 to clear) have always been the fast way and still are;
 * this is for the times your hand is on the mouse, and so that a rating is
 * visible and reachable in the darkroom without remembering a key exists.
 *
 * Clicking the star a photograph already has clears it — the same rule
 * Lightroom uses, and the reason there is no separate clear button.
 */
function Rating({ path, stars }: { path: string; stars: number | null }) {
  const rate = async (next: number | null) => {
    useAppStore.getState().labelApplied(path, await labelsSetStars(path, next));
  };
  return (
    <div className="info-fact">
      <span className="info-fact-label">rating</span>
      <span className="info-rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={stars !== null && n <= stars ? "on" : ""}
            title={n === stars ? "click to clear" : `${n} star${n > 1 ? "s" : ""}`}
            onClick={() => void rate(n === stars ? null : n)}
          >
            ★
          </button>
        ))}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-fact">
      <span className="info-fact-label">{label}</span>
      <span className="info-fact-value" title={value}>
        {value}
      </span>
    </div>
  );
}

/** Intensity (Rec. 709 luma) as a filled area, scaled to the tallest bin. */
function HistogramCanvas({ stats }: { stats: ImageStats }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, ...stats.luma);
    ctx.fillStyle = "rgba(200, 200, 200, 0.7)";
    ctx.beginPath();
    ctx.moveTo(0, h);
    stats.luma.forEach((count, bin) =>
      ctx.lineTo((bin / 255) * (w - 1), h - (count / max) * (h - 2)),
    );
    ctx.lineTo(w, h);
    ctx.fill();
  }, [stats]);
  return <canvas ref={ref} className="info-canvas" width={224} height={72} />;
}

/**
 * Maxwell triangle, equilateral: blue bottom-left, red bottom-right, green
 * top, tessellated into N² small ▲/▽ triangles (the natural simplex split).
 * Each cell is painted in its own hue; opacity is log-scaled pixel density,
 * fully opaque at the densest cell so sparse single-color cells stay faint.
 */
function TriangleCanvas({ stats }: { stats: ImageStats }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const n = stats.triangleN;
    const maxLog = Math.max(
      1e-6,
      ...stats.triUp.map((c) => Math.log1p(c)),
      ...stats.triDown.map((c) => Math.log1p(c)),
    );
    // Barycentric (u = red, v = green) → pixels: blue at bottom-left.
    const px = (u: number, v: number) => ({ x: u * w + v * (w / 2), y: h - v * h });

    const cell = (a: number, b: number, down: boolean, count: number) => {
      if (count === 0) return;
      // Cell centroid in barycentric coordinates gives the hue.
      const u = (3 * a + (down ? 2 : 1)) / (3 * n);
      const v = (3 * b + (down ? 2 : 1)) / (3 * n);
      const bl = Math.max(0, 1 - u - v);
      const peak = Math.max(u, v, bl);
      const alpha = Math.pow(Math.log1p(count) / maxLog, 1.5);
      ctx.fillStyle = `rgba(${Math.round((255 * u) / peak)}, ${Math.round(
        (255 * v) / peak,
      )}, ${Math.round((255 * bl) / peak)}, ${alpha})`;
      const corners = down
        ? [px((a + 1) / n, b / n), px(a / n, (b + 1) / n), px((a + 1) / n, (b + 1) / n)]
        : [px(a / n, b / n), px((a + 1) / n, b / n), px(a / n, (b + 1) / n)];
      ctx.beginPath();
      corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.fill();
    };

    for (let b = 0; b < n; b += 1) {
      for (let a = 0; a + b < n; a += 1) {
        cell(a, b, false, stats.triUp[b * n + a] ?? 0);
        if (a + b < n - 1) cell(a, b, true, stats.triDown[b * n + a] ?? 0);
      }
    }
  }, [stats]);
  // Height = width · √3/2 keeps the triangle's angles at 60°.
  return <canvas ref={ref} className="info-canvas" width={224} height={194} />;
}

export function InfoPanel() {
  const entry = useSelectedEntry();
  const meta = useAppStore((s) => (entry ? s.meta[entry.path] : undefined));
  const labels = useAppStore((s) => (entry ? s.labels[entry.path] : undefined));

  const [stats, setStats] = useState<{ path: string; data: ImageStats } | null>(null);

  const path = entry?.path;
  const isLocal = path !== undefined && !path.startsWith("http");
  useEffect(() => {
    if (path === undefined || !isLocal) {
      setStats(null);
      return;
    }
    const timer = setTimeout(() => {
      imageStats(path)
        .then((data) => setStats({ path, data }))
        // Undecodable (e.g. AVIF has no Rust codec): facts only, no charts.
        .catch(() => setStats(null));
    }, STATS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path, isLocal]);

  if (!entry) return <p className="panel-hint">No image selected.</p>;

  const exif = meta?.exif ?? null;
  const stars = labels?.stars ?? null;
  const tags = labels?.tags ?? [];
  const current = stats !== null && stats.path === path ? stats.data : null;
  // Shutter, aperture, ISO — whichever the file carries, worded by the same
  // formatters the caption over the image uses, so the two never disagree.
  const exposure = [
    exif?.exposureTime != null ? formatShutter(exif.exposureTime) : "",
    exif?.fNumber != null ? formatAperture(exif.fNumber) : "",
    exif?.iso != null ? `ISO ${exif.iso}` : "",
  ].filter(Boolean);

  return (
    <div className="info-panel">
      <Section title="File">
        <Fact label="name" value={entry.name} />
        {meta && <Fact label="dimensions" value={`${meta.width} × ${meta.height}`} />}
        <Fact label="size" value={formatBytes(entry.size)} />
        <Fact label="format" value={entry.formatHint.toUpperCase()} />
        <Fact label="modified" value={new Date(entry.modifiedMs).toLocaleString()} />
      </Section>
      {exif && (
        <Section title="EXIF">
          {exif.camera !== null && <Fact label="camera" value={exif.camera} />}
          {exif.lens !== null && <Fact label="lens" value={exif.lens} />}
          {/* The exposure on one line, the way a photographer states it —
              three separate rows would make you assemble it yourself. */}
          {exposure.length > 0 && <Fact label="exposure" value={exposure.join("   ")} />}
          {exif.focalLength !== null && (
            <Fact label="focal length" value={`${Math.round(exif.focalLength)} mm`} />
          )}
          {exif.dateTime !== null && <Fact label="taken" value={exif.dateTime} />}
          {exif.gpsLat !== null && exif.gpsLon !== null && (
            <Fact label="location" value={`${exif.gpsLat.toFixed(5)}, ${exif.gpsLon.toFixed(5)}`} />
          )}
        </Section>
      )}
      <Section title="Labels">
        <Rating path={entry.path} stars={stars} />
        {tags.length > 0 && <Fact label="tags" value={tags.join(", ")} />}
      </Section>
      {current && (
        <>
          <Section title="Histogram">
            <HistogramCanvas stats={current} />
          </Section>
          <Section title="Colors">
            <TriangleCanvas stats={current} />
          </Section>
        </>
      )}
    </div>
  );
}
