import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ImageStats } from "../../ipc";
import { formatAperture, formatShutter, formatSigned } from "../../facts/builtin";
import { imageStats, labelsSetStars } from "../../ipc";
import { titleWithChord } from "../../registry/keybindings";
import { useDevelopStore } from "../../state/develop";
import { DevelopLoupe } from "../develop/DevelopLoupe";
import { formatBytes } from "../../state/stats";
import { filesBehind, useAppStore, useSelectedEntry } from "../../state/store";

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
  // This one photograph, not the selection: the panel is describing a single
  // image, and its controls should change what it is describing. But one
  // photograph can be two files — a collapsed raw+JPEG pair is rated whole.
  const rate = async (next: number | null) => {
    const s = useAppStore.getState();
    const entry = s.entries.find((e) => e.path === path);
    const files = entry ? filesBehind(s, [entry]).map((f) => f.path) : [path];
    s.labelsApplied(await labelsSetStars(files, next));
  };
  return (
    <div className="info-fact">
      <span className="info-fact-label">rating</span>
      <span className="info-rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={stars !== null && n <= stars ? "on" : ""}
            title={titleWithChord(
              n === stars ? "click to clear" : `${n} star${n > 1 ? "s" : ""}`,
              `labels.stars.${n === stars ? 0 : n}`,
            )}
            onClick={() => void rate(n === stars ? null : n)}
          >
            ★
          </button>
        ))}
      </span>
    </div>
  );
}

/** Shutter speed: a stopwatch. */
function ShutterIcon() {
  return (
    <svg className="develop-shot-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="14" r="8" />
      <path d="M12 10v4l2.8 2" />
      <path d="M9 2h6" />
      <path d="M12 2v4" />
    </svg>
  );
}

/** Aperture: the iris, six blades. */
function ApertureIcon() {
  return (
    <svg className="develop-shot-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
      <line x1="9.69" y1="8" x2="21.17" y2="8" />
      <line x1="7.38" y1="12" x2="13.12" y2="2.06" />
      <line x1="9.69" y1="16" x2="3.95" y2="6.06" />
      <line x1="14.31" y1="16" x2="2.83" y2="16" />
      <line x1="16.62" y1="12" x2="10.88" y2="21.94" />
    </svg>
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
  const hasSession = useDevelopStore((s) => s.session !== null);
  const developShowing = useAppStore(
    (s) => s.galleryLayout === "darkroom" || s.viewMode === "viewer",
  );
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
  // The shot on one line, the way a photographer states it. Most readings
  // carry their own unit; shutter and aperture wear a small icon each, and
  // EV speaks even at zero — the compensation you *didn't* dial in is part
  // of reading the frame.
  const shotFacts: Array<{ key: string; title: string; icon: ReactNode; text: string }> = [];
  if (exif?.exposureTime != null) {
    shotFacts.push({
      key: "shutter",
      title: "shutter speed",
      icon: <ShutterIcon />,
      text: formatShutter(exif.exposureTime),
    });
  }
  if (exif?.fNumber != null) {
    shotFacts.push({
      key: "aperture",
      title: "aperture",
      icon: <ApertureIcon />,
      text: formatAperture(exif.fNumber),
    });
  }
  if (exif?.iso != null) {
    shotFacts.push({ key: "iso", title: "sensitivity", icon: null, text: `ISO ${exif.iso}` });
  }
  if (exif?.exposureBias != null) {
    shotFacts.push({
      key: "ev",
      title: "exposure compensation, as dialed on the camera",
      icon: null,
      text: `${exif.exposureBias === 0 ? "0" : formatSigned(exif.exposureBias)} EV`,
    });
  }
  if (exif?.focalLength != null) {
    shotFacts.push({
      key: "focal",
      title: exif.lens ?? "focal length",
      icon: null,
      text: `${Math.round(exif.focalLength)} mm`,
    });
  }
  // The camera's own per-shot grade, when the file carries one — the answer
  // to "why do these two neighbouring shots look different".
  const grade = meta?.grade
    ? [
        meta.grade.contrast !== 0 ? `contrast ${formatSigned(meta.grade.contrast)}` : "",
        meta.grade.saturation !== 0 ? `sat ${formatSigned(meta.grade.saturation)}` : "",
        meta.grade.clarity !== 0 ? `clarity ${formatSigned(meta.grade.clarity)}` : "",
        meta.grade.texture !== 0 ? `texture ${formatSigned(meta.grade.texture)}` : "",
      ].filter(Boolean)
    : [];

  return (
    <div className="info-panel">
      <Section title="File">
        <Fact label="name" value={entry.name} />
        {meta && <Fact label="dimensions" value={`${meta.width} × ${meta.height}`} />}
        <Fact label="size" value={formatBytes(entry.size)} />
        <Fact label="format" value={entry.formatHint.toUpperCase()} />
        <Fact label="modified" value={new Date(entry.modifiedMs).toLocaleString()} />
      </Section>
      {/* True 100% pixels — culling wants sharpness at a glance in every
          view. Drag the photograph (darkroom) to aim it. */}
      {hasSession && (
        <Section title="Loupe">
          <DevelopLoupe />
        </Section>
      )}
      {exif && (
        <Section title="Shot">
          {shotFacts.length > 0 && (
            <p className="develop-shot">
              {shotFacts.map((fact) => (
                <span key={fact.key} className="develop-shot-fact" title={fact.title}>
                  {fact.icon}
                  {fact.text}
                </span>
              ))}
            </p>
          )}
          {exif.camera !== null && <Fact label="camera" value={exif.camera} />}
          {exif.lens !== null && <Fact label="lens" value={exif.lens} />}
          {grade.length > 0 && <Fact label="camera grade" value={grade.join("   ")} />}
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
      {/* One histogram on screen at a time: the Develop panel pins the live
          one, so this file-side copy shows only where Develop is absent. */}
      {current && !developShowing && (
        <Section title="Histogram">
          <HistogramCanvas stats={current} />
        </Section>
      )}
      {current && (
        <Section title="Colors">
          <TriangleCanvas stats={current} />
        </Section>
      )}
    </div>
  );
}
