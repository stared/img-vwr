import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ImageMeta } from "../../ipc";
import { requestMeta } from "../../ipc";
import type { Dims } from "../../state/derived";
import { effectiveDims, takenMs } from "../../state/derived";
import { activeFormats } from "../../state/query";
import type { Bucket, NumericHistogram } from "../../state/stats";
import {
  aspectBuckets,
  cameraCounts,
  formatBytes,
  formatCounts,
  log2Bins,
  orientationSplit,
  timeBuckets,
} from "../../state/stats";
import { useAppStore, useVisibleEntries } from "../../state/store";

/** Time buckets are already contiguous bins; the first/last labels are the axis. */
function toTimeHistogram(buckets: Bucket[]): NumericHistogram | null {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (!first || !last) return null;
  return { bins: buckets, minLabel: first.label, maxLabel: last.label };
}

/** Lightroom-style panel section: separator line + header that collapses its body. */
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

/** Clicking a bucket toggles it as a query filter; the active one is marked. */
interface Selectable {
  onSelect?: (bucket: Bucket) => void;
  isActive?: (bucket: Bucket) => boolean;
}

/** Labelled horizontal bars; bar lengths are relative to the largest bucket. */
function Histogram({
  title,
  buckets,
  note,
  onSelect,
  isActive,
}: {
  title: string;
  buckets: Bucket[];
  note?: string;
} & Selectable) {
  if (buckets.length === 0 && !note) return null;
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 1);
  return (
    <Section title={title}>
      {buckets.map((bucket) => {
        const clickable = onSelect !== undefined && bucket.value !== undefined;
        const Row = clickable ? "button" : "div";
        return (
          <Row
            key={bucket.label}
            className={`stats-row${isActive?.(bucket) ? " active" : ""}`}
            title={clickable ? `filter: ${bucket.label}` : `${bucket.label}: ${bucket.count}`}
            onClick={clickable ? () => onSelect(bucket) : undefined}
          >
            <span className="stats-label">{bucket.label}</span>
            <span className="stats-bar">
              <span style={{ width: `${(100 * bucket.count) / max}%` }} />
            </span>
            <span className="stats-count">{bucket.count}</span>
          </Row>
        );
      })}
      {note && <p className="stats-note">{note}</p>}
    </Section>
  );
}

/** A proper histogram: contiguous vertical bins with the data range as axis labels. */
function ColumnChart({
  title,
  histogram,
  note,
  onSelect,
  isActive,
}: {
  title: string;
  histogram: NumericHistogram | null;
  note?: string;
} & Selectable) {
  if (histogram === null && !note) return null;
  return (
    <Section title={title}>
      {histogram &&
        (() => {
          const max = histogram.bins.reduce((m, b) => Math.max(m, b.count), 1);
          return (
            <>
              <div className={`stats-histo${onSelect ? " selectable" : ""}`}>
                {histogram.bins.map((bin, i) => (
                  <span
                    key={i}
                    className={isActive?.(bin) ? "active" : undefined}
                    title={onSelect ? `filter: ${bin.label}` : `${bin.label}: ${bin.count}`}
                    onClick={onSelect && bin.from !== undefined ? () => onSelect(bin) : undefined}
                  >
                    <span
                      style={{
                        height: bin.count > 0 ? `${Math.max(4, (100 * bin.count) / max)}%` : 0,
                      }}
                    />
                  </span>
                ))}
              </div>
              <div className="stats-axis">
                <span>{histogram.minLabel}</span>
                <span>{histogram.maxLabel}</span>
              </div>
            </>
          );
        })()}
      {note && <p className="stats-note">{note}</p>}
    </Section>
  );
}

/** Ranked label–count list, for long labels (camera models) where bars crowd. */
function CountList({
  title,
  buckets,
  note,
  onSelect,
  isActive,
}: {
  title: string;
  buckets: Bucket[];
  note?: string;
} & Selectable) {
  if (buckets.length === 0 && !note) return null;
  return (
    <Section title={title}>
      {buckets.map((bucket) => {
        const clickable = onSelect !== undefined && bucket.value !== undefined;
        const Row = clickable ? "button" : "div";
        return (
          <Row
            key={bucket.label}
            className={`stats-row list${isActive?.(bucket) ? " active" : ""}`}
            title={clickable ? `filter: ${bucket.label}` : `${bucket.label}: ${bucket.count}`}
            onClick={clickable ? () => onSelect(bucket) : undefined}
          >
            <span className="stats-label">{bucket.label}</span>
            <span className="stats-count">{bucket.count}</span>
          </Row>
        );
      })}
      {note && <p className="stats-note">{note}</p>}
    </Section>
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
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const status = useAppStore((s) => s.status);
  const epoch = useAppStore((s) => s.epoch);
  const meta = useAppStore((s) => s.meta);
  const query = useAppStore((s) => s.query);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);
  const toggleRangeFilter = useAppStore((s) => s.toggleRangeFilter);

  // One background read per folder generation; results are keyed by path and
  // merged as batches arrive. getState() keeps `meta` out of the deps so
  // arriving batches don't re-fire requests for paths already in flight.
  // Remote sources arrive with metadata prefilled — nothing to read locally.
  useEffect(() => {
    if (status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void requestMeta(missing, epoch);
  }, [status, remote, allEntries, epoch]);

  const stats = useMemo(() => {
    const metas = entries
      .map((e) => meta[e.path])
      .filter((m): m is ImageMeta => m !== undefined);
    const dims = metas
      .map(effectiveDims)
      .filter((d): d is Dims => d !== null);
    const taken = metas.map(takenMs).filter((t): t is number => t !== null);
    return {
      read: metas.length,
      totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
      formats: formatCounts(entries),
      taken: toTimeHistogram(timeBuckets(taken, 48)),
      noTaken: metas.length - taken.length,
      modified: toTimeHistogram(timeBuckets(entries.map((e) => e.modifiedMs), 48)),
      cameras: cameraCounts(metas),
      noCamera: metas.filter((m) => !m.exif?.camera).length,
      orientation: orientationSplit(dims),
      aspects: aspectBuckets(dims),
      // Log scale: pixel dimensions cluster in octaves (1k, 2k, 4k…);
      // 3 bins per octave keeps e.g. 3024 and 4032 distinguishable.
      edges: log2Bins(dims.map((d) => Math.max(d.width, d.height)), (n) => String(Math.round(n)), 3),
      sizes: log2Bins(entries.map((e) => e.size), formatBytes),
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

  // Click-to-filter wiring: each section toggles its own query clause,
  // keyed by the registered filter field it corresponds to.
  const selectRange = (field: string) => (b: Bucket) => {
    if (b.from !== undefined && b.to !== undefined) {
      toggleRangeFilter(field, b.from, b.to, b.label);
    }
  };
  const rangeActive = (field: string) => (b: Bucket) =>
    query.filters.some(
      (f) => f.kind === "range" && f.field === field && f.from === b.from && f.to === b.to,
    );
  const formatActive = (b: Bucket) => b.value !== undefined && activeFormats(query).includes(b.value);
  const selectActive = (field: string) => (b: Bucket) =>
    query.filters.some((f) => f.kind === "select" && f.field === field && f.value === b.value);
  const selectValue = (field: string) => (b: Bucket) => {
    if (b.value !== undefined) toggleSelectFilter(field, b.value);
  };

  return (
    <div className="stats">
      <Section title="summary">
        <p className="stats-summary">
          {entries.length} images
          {/* Some sources (Reddit) don't report file sizes at all. */}
          {stats.totalBytes > 0 && <> · {formatBytes(stats.totalBytes)}</>}
          {reading && (
            <span className="stats-progress">
              {" "}
              · reading {stats.read}/{entries.length}…
            </span>
          )}
        </p>
      </Section>
      <Histogram
        title="format"
        buckets={stats.formats}
        onSelect={(b) => {
          if (b.value !== undefined) toggleFormatFilter(b.value);
        }}
        isActive={formatActive}
      />
      <ColumnChart
        title="taken"
        histogram={stats.taken}
        note={stats.noTaken > 0 ? `no date tag: ${stats.noTaken}` : undefined}
        onSelect={selectRange("taken")}
        isActive={rangeActive("taken")}
      />
      <ColumnChart
        title="modified"
        histogram={stats.modified}
        onSelect={selectRange("modified")}
        isActive={rangeActive("modified")}
      />
      <CountList
        title="camera"
        buckets={stats.cameras}
        note={stats.noCamera > 0 ? `no camera tag: ${stats.noCamera}` : undefined}
        onSelect={selectValue("camera")}
        isActive={selectActive("camera")}
      />
      <Histogram
        title="aspect ratio"
        buckets={stats.aspects}
        note={orientationNote || undefined}
        onSelect={selectValue("aspect")}
        isActive={selectActive("aspect")}
      />
      <ColumnChart
        title="longest edge"
        histogram={stats.edges}
        onSelect={selectRange("edge")}
        isActive={rangeActive("edge")}
      />
      <ColumnChart
        title="file size"
        histogram={stats.sizes}
        onSelect={selectRange("size")}
        isActive={rangeActive("size")}
      />
    </div>
  );
}
