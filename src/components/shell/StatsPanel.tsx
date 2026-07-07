import { useEffect, useMemo } from "react";

import type { ImageMeta } from "../../ipc";
import { requestMeta } from "../../ipc";
import type { Bucket, Dims } from "../../state/stats";
import {
  aspectBuckets,
  cameraCounts,
  edgeBuckets,
  effectiveDims,
  formatBytes,
  formatCounts,
  orientationSplit,
  parseExifDate,
  sizeBuckets,
  timeBuckets,
} from "../../state/stats";
import { useAppStore, useVisibleEntries } from "../../state/store";

/** Labelled horizontal bars; bar lengths are relative to the largest bucket. */
function Histogram({ title, buckets, note }: { title: string; buckets: Bucket[]; note?: string }) {
  if (buckets.length === 0 && !note) return null;
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 1);
  return (
    <section className="stats-section">
      <h3>{title}</h3>
      {buckets.map((bucket) => (
        <div key={bucket.label} className="stats-row" title={`${bucket.label}: ${bucket.count}`}>
          <span className="stats-label">{bucket.label}</span>
          <span className="stats-bar">
            <span style={{ width: `${(100 * bucket.count) / max}%` }} />
          </span>
          <span className="stats-count">{bucket.count}</span>
        </div>
      ))}
      {note && <p className="stats-note">{note}</p>}
    </section>
  );
}

/** Ranked label–count list, for long labels (camera models) where bars crowd. */
function CountList({ title, buckets, note }: { title: string; buckets: Bucket[]; note?: string }) {
  if (buckets.length === 0 && !note) return null;
  return (
    <section className="stats-section">
      <h3>{title}</h3>
      {buckets.map((bucket) => (
        <div key={bucket.label} className="stats-row list" title={`${bucket.label}: ${bucket.count}`}>
          <span className="stats-label">{bucket.label}</span>
          <span className="stats-count">{bucket.count}</span>
        </div>
      ))}
      {note && <p className="stats-note">{note}</p>}
    </section>
  );
}

/**
 * Collection statistics over the visible (query-applied) entries. File facts
 * (formats, sizes, modified times) come straight from the scan; pixel and
 * EXIF facts stream in from a background metadata pass, so the panel fills
 * in as data arrives — never blocking on it.
 */
export function StatsPanel() {
  const entries = useVisibleEntries();
  const allEntries = useAppStore((s) => s.entries);
  const status = useAppStore((s) => s.status);
  const epoch = useAppStore((s) => s.epoch);
  const meta = useAppStore((s) => s.meta);

  // One background read per folder generation; results are keyed by path and
  // merged as batches arrive. getState() keeps `meta` out of the deps so
  // arriving batches don't re-fire requests for paths already in flight.
  useEffect(() => {
    if (status !== "loaded" || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [status, allEntries, epoch]);

  const stats = useMemo(() => {
    const metas = entries
      .map((e) => meta[e.path])
      .filter((m): m is ImageMeta => m !== undefined);
    const dims = metas
      .map(effectiveDims)
      .filter((d): d is Dims => d !== null);
    const taken = metas
      .map((m) => (m.exif?.dateTime ? parseExifDate(m.exif.dateTime) : null))
      .filter((t): t is number => t !== null);
    return {
      read: metas.length,
      totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
      formats: formatCounts(entries),
      taken: timeBuckets(taken),
      noTaken: metas.length - taken.length,
      modified: timeBuckets(entries.map((e) => e.modifiedMs)),
      cameras: cameraCounts(metas),
      noCamera: metas.filter((m) => !m.exif?.camera).length,
      orientation: orientationSplit(dims),
      aspects: aspectBuckets(dims),
      edges: edgeBuckets(dims),
      sizes: sizeBuckets(entries.map((e) => e.size)),
    };
  }, [entries, meta]);

  if (status !== "loaded" || entries.length === 0) {
    return <p className="panel-hint">No images to summarize.</p>;
  }

  const { landscape, portrait, square } = stats.orientation;
  const orientationNote = [
    landscape > 0 && `landscape ${landscape}`,
    portrait > 0 && `portrait ${portrait}`,
    square > 0 && `square ${square}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const reading = stats.read < entries.length;

  return (
    <div className="stats">
      <p className="stats-summary">
        {entries.length} images · {formatBytes(stats.totalBytes)}
        {reading && (
          <span className="stats-progress">
            {" "}
            · reading {stats.read}/{entries.length}…
          </span>
        )}
      </p>
      <Histogram title="format" buckets={stats.formats} />
      <Histogram
        title="taken"
        buckets={stats.taken}
        note={stats.noTaken > 0 ? `no date tag: ${stats.noTaken}` : undefined}
      />
      <Histogram title="modified" buckets={stats.modified} />
      <CountList
        title="camera"
        buckets={stats.cameras}
        note={stats.noCamera > 0 ? `no camera tag: ${stats.noCamera}` : undefined}
      />
      <Histogram title="aspect ratio" buckets={stats.aspects} note={orientationNote || undefined} />
      <Histogram title="longest edge" buckets={stats.edges} />
      <Histogram title="file size" buckets={stats.sizes} />
    </div>
  );
}
