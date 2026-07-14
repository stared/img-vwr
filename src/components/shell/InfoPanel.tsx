import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ImageStats } from "../../ipc";
import { imageStats } from "../../ipc";
import { formatBytes } from "../../state/stats";
import { useAppStore, useVisibleEntries } from "../../state/store";

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

/** Luma as a filled area, R/G/B as lines, all scaled to the tallest bin. */
function HistogramCanvas({ stats }: { stats: ImageStats }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const channels = [stats.luma, stats.red, stats.green, stats.blue];
    const max = Math.max(1, ...channels.flatMap((c) => c));
    const x = (bin: number) => (bin / 255) * (w - 1);
    const y = (count: number) => h - (count / max) * (h - 2);

    ctx.fillStyle = "rgba(160, 160, 160, 0.45)";
    ctx.beginPath();
    ctx.moveTo(0, h);
    stats.luma.forEach((count, bin) => ctx.lineTo(x(bin), y(count)));
    ctx.lineTo(w, h);
    ctx.fill();

    const lines: [number[], string][] = [
      [stats.red, "rgba(255, 90, 90, 0.9)"],
      [stats.green, "rgba(90, 220, 90, 0.9)"],
      [stats.blue, "rgba(110, 140, 255, 0.9)"],
    ];
    for (const [bins, color] of lines) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      bins.forEach((count, bin) =>
        bin === 0 ? ctx.moveTo(x(bin), y(count)) : ctx.lineTo(x(bin), y(count)),
      );
      ctx.stroke();
    }
  }, [stats]);
  return <canvas ref={ref} className="info-canvas" width={224} height={72} />;
}

/**
 * Maxwell triangle: each grid cell sits at barycentric (r, g, b) and is
 * painted in that hue; opacity is log-scaled pixel density. Blue corner
 * bottom-left, red bottom-right, green top.
 */
function TriangleCanvas({ stats }: { stats: ImageStats }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const grid = stats.triangleGrid;
    const cell = { w: w / grid, h: h / grid };
    const maxLog = Math.max(1e-6, ...stats.triangle.map((c) => Math.log1p(c)));

    for (let row = 0; row < grid; row += 1) {
      for (let col = 0; col < grid; col += 1) {
        const count = stats.triangle[row * grid + col] ?? 0;
        if (count === 0) continue;
        const r = (col + 0.5) / grid;
        const g = (row + 0.5) / grid;
        const b = Math.max(0, 1 - r - g);
        const peak = Math.max(r, g, b);
        const alpha = 0.25 + 0.75 * (Math.log1p(count) / maxLog);
        ctx.fillStyle = `rgba(${Math.round((255 * r) / peak)}, ${Math.round(
          (255 * g) / peak,
        )}, ${Math.round((255 * b) / peak)}, ${alpha})`;
        // x → red fraction, y (up) → green fraction.
        ctx.fillRect(col * cell.w, h - (row + 1) * cell.h, Math.ceil(cell.w), Math.ceil(cell.h));
      }
    }

    // The triangle's outline: r + g ≤ 1.
    ctx.strokeStyle = "rgba(128, 128, 128, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w - 1, h - 1);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.stroke();
  }, [stats]);
  return <canvas ref={ref} className="info-canvas" width={224} height={160} />;
}

export function InfoPanel() {
  const index = useAppStore((s) => s.selectedIndex);
  const visible = useVisibleEntries();
  const entry = visible[index];
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
          {exif.dateTime !== null && <Fact label="taken" value={exif.dateTime} />}
          {exif.gpsLat !== null && exif.gpsLon !== null && (
            <Fact label="location" value={`${exif.gpsLat.toFixed(5)}, ${exif.gpsLon.toFixed(5)}`} />
          )}
        </Section>
      )}
      {(stars !== null || tags.length > 0) && (
        <Section title="Labels">
          {stars !== null && <Fact label="rating" value={"★".repeat(stars)} />}
          {tags.length > 0 && <Fact label="tags" value={tags.join(", ")} />}
        </Section>
      )}
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
