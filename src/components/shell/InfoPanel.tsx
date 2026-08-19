import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ImageStats } from "../../ipc";
import { formatAperture, formatShutter, formatSigned } from "../../facts/builtin";
import { imageStats, labelsSetStars } from "../../ipc";
import { titleWithChord } from "../../registry/keybindings";
import { useDevelopStore } from "../../state/develop";
import { DevelopHistogram } from "../develop/DevelopHistogram";
import { formatBytes } from "../../state/stats";
import { filesBehind, useAppStore, useSelectedEntry } from "../../state/store";

const STATS_DEBOUNCE_MS = 150;

function ShutterIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="14" r="8" />
      <path d="M12 10v4l2.8 2" />
      <path d="M9 2h6" />
      <path d="M12 2v4" />
    </svg>
  );
}

function ApertureIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
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

function FocalIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 12 h17" />
      <path d="M7 8.5 L3.5 12 L7 15.5" />
      <path d="M17 8.5 L20.5 12 L17 15.5" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="7" width="19" height="13" rx="2.5" />
      <circle cx="12" cy="13.5" r="4" />
      <path d="M8 7 L9.5 4.5 h5 L16 7" />
    </svg>
  );
}

function LensIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

function TakenIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10 h17" />
      <path d="M8 2.5 v5" />
      <path d="M16 2.5 v5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="exif-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 2.5 h8 l5 5 v14 h-13 z" />
      <path d="M14 2.5 v5 h5" />
    </svg>
  );
}

interface ExifCell {
  key: string;
  title: string;
  mark: ReactNode;
  text: string;
}

export function ShotPanel() {
  const entry = useSelectedEntry();
  const meta = useAppStore((s) => (entry ? s.meta[entry.path] : undefined));
  if (!entry) return null;

  const exif = meta?.exif ?? null;
  const word = (text: string) => <span className="exif-mark-word">{text}</span>;
  const cells: ExifCell[] = [];
  if (exif?.exposureTime != null) {
    cells.push({
      key: "shutter",
      title: "shutter speed",
      mark: <ShutterIcon />,
      text: formatShutter(exif.exposureTime),
    });
  }
  if (exif?.fNumber != null) {
    cells.push({
      key: "aperture",
      title: "aperture",
      mark: <ApertureIcon />,
      text: formatAperture(exif.fNumber),
    });
  }
  if (exif?.iso != null) {
    cells.push({ key: "iso", title: "sensitivity", mark: word("ISO"), text: `${exif.iso}` });
  }
  if (exif?.focalLength != null) {
    cells.push({
      key: "focal",
      title: "focal length",
      mark: <FocalIcon />,
      text: `${Math.round(exif.focalLength)} mm`,
    });
  }
  if (exif?.exposureBias != null) {
    cells.push({
      key: "ev",
      title: "exposure compensation, as dialed on the camera",
      mark: word("EV"),
      text: exif.exposureBias === 0 ? "0" : formatSigned(exif.exposureBias),
    });
  }

  const grade = meta?.grade
    ? [
        meta.grade.contrast !== 0 ? `contrast ${formatSigned(meta.grade.contrast)}` : "",
        meta.grade.saturation !== 0 ? `saturation ${formatSigned(meta.grade.saturation)}` : "",
        meta.grade.clarity !== 0 ? `clarity ${formatSigned(meta.grade.clarity)}` : "",
        meta.grade.texture !== 0 ? `texture ${formatSigned(meta.grade.texture)}` : "",
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  // slice(0, 16) keeps the timestamp to the minute.
  const taken = (exif?.dateTime ?? new Date(entry.modifiedMs).toLocaleString()).slice(0, 16);
  const place =
    exif?.gpsLat != null && exif?.gpsLon != null
      ? `${exif.gpsLat.toFixed(5)}, ${exif.gpsLon.toFixed(5)}`
      : "";

  return (
    <div className="shot-panel">
      {cells.length > 0 && (
        <div className="exif-strip">
          {cells.map((cell) => (
            <span key={cell.key} className="exif-cell" title={cell.title}>
              {cell.mark}
              {cell.text}
            </span>
          ))}
        </div>
      )}
      {(exif?.camera != null || exif?.lens != null) && (
        <p className="shot-row wrap">
          {exif?.camera != null && (
            <span className="shot-seg" title="camera">
              <CameraIcon />
              {exif.camera}
            </span>
          )}
          {exif?.lens != null && (
            <span className="shot-seg" title="lens">
              <LensIcon />
              {exif.lens}
            </span>
          )}
        </p>
      )}
      {grade !== "" && (
        <p className="shot-line" title="the camera's own per-shot grade">
          {grade}
        </p>
      )}
      <div className="shot-foot">
        <span className="shot-row" title="taken">
          <TakenIcon />
          {taken}
        </span>
        <span className="shot-row" title="file size">
          <FileIcon />
          {formatBytes(entry.size)}
        </span>
      </div>
      {place !== "" && <p className="shot-line">{place}</p>}
    </div>
  );
}

export function LabelsPanel() {
  const entry = useSelectedEntry();
  const labels = useAppStore((s) => (entry ? s.labels[entry.path] : undefined));
  if (!entry) return null;
  const stars = labels?.stars ?? null;
  const tags = labels?.tags ?? [];

  const rate = async (next: number | null) => {
    const s = useAppStore.getState();
    const files = filesBehind(s, [entry]).map((f) => f.path);
    s.labelsApplied(await labelsSetStars(files.length > 0 ? files : [entry.path], next));
  };

  return (
    <div className="shot-panel">
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
      {tags.length > 0 && <p className="shot-line">{tags.join(", ")}</p>}
    </div>
  );
}

export function HistogramPanel() {
  const histogram = useDevelopStore((s) => s.session?.frame?.histogram ?? null);
  return <DevelopHistogram histogram={histogram} />;
}

/** Maxwell triangle of pixel hues; opacity is log-scaled density, computed by Rust on the cached thumbnail. */
export function ColorsPanel() {
  const entry = useSelectedEntry();
  const path = entry?.path;
  const isLocal = path !== undefined && !path.startsWith("http");
  const [stats, setStats] = useState<{ path: string; data: ImageStats } | null>(null);

  useEffect(() => {
    if (path === undefined || !isLocal) {
      setStats(null);
      return;
    }
    const timer = setTimeout(() => {
      imageStats(path)
        .then((data) => setStats({ path, data }))
        // Undecodable (e.g. AVIF has no Rust codec): no chart.
        .catch(() => setStats(null));
    }, STATS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path, isLocal]);

  const current = stats !== null && stats.path === path ? stats.data : null;
  if (current === null) return null;
  return (
    <div className="info-panel">
      <TriangleCanvas stats={current} />
    </div>
  );
}

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
