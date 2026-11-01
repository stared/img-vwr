import { useMemo, useState, type ReactNode } from "react";

import type { ImageMeta } from "../../ipc";
import { getFilterField } from "../../registry/filters";
import type { Dims } from "../../state/derived";
import { effectiveDims } from "../../state/derived";
import type { RangeOp } from "../../state/query";
import { activeFormats, formatChoices, isAnyPicked, isPicked, OP_SYMBOL } from "../../state/query";
import { aspectBuckets, cameraCounts } from "../../state/stats";
import { useAppStore } from "../../state/store";

export function FormatMenuItems() {
  const query = useAppStore((s) => s.query);
  const entries = useAppStore((s) => s.entries);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);
  const formats = activeFormats(query);
  const choices = useMemo(() => formatChoices(entries), [entries]);
  return (
    <>
      {choices.map((c) => (
        <button
          key={c.id}
          className={c.count === 0 ? "menu-absent" : undefined}
          onClick={() => toggleFormatFilter(c.id)}
        >
          {c.label}
          <span className="menu-hint">{c.count === 0 ? "none here" : c.count}</span>
          <span className="menu-check">{formats.includes(c.id) ? "✓" : ""}</span>
        </button>
      ))}
    </>
  );
}

function useCollectionMetas(): ImageMeta[] {
  const entries = useAppStore((s) => s.entries);
  const meta = useAppStore((s) => s.meta);
  return useMemo(
    () => entries.map((e) => meta[e.path]).filter((m): m is ImageMeta => m !== undefined),
    [entries, meta],
  );
}

/** Rows toggle, so one clause can hold several values; `anyLabel` adds the any-value row on top. */
export function SelectMenuItems({
  field,
  anyLabel,
  buckets,
  empty,
}: {
  field: string;
  anyLabel: string | null;
  buckets: { label: ReactNode; value: string }[];
  empty: string;
}) {
  const query = useAppStore((s) => s.query);
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);
  const toggleSelectAny = useAppStore((s) => s.toggleSelectAny);
  if (buckets.length === 0) {
    return <span className="menu-empty">{empty}</span>;
  }
  return (
    <>
      {anyLabel !== null && (
        <button onClick={() => toggleSelectAny(field)}>
          {anyLabel}
          <span className="menu-check">{isAnyPicked(query, field) ? "✓" : ""}</span>
        </button>
      )}
      {buckets.map((b) => (
        <button key={b.value} onClick={() => toggleSelectFilter(field, b.value)}>
          {b.label}
          <span className="menu-check">{isPicked(query, field, b.value) ? "✓" : ""}</span>
        </button>
      ))}
    </>
  );
}

export function CameraMenuItems() {
  const metas = useCollectionMetas();
  const buckets = cameraCounts(metas, 12).flatMap((b) =>
    b.value !== undefined ? [{ label: b.label, value: b.value }] : [],
  );
  return (
    <SelectMenuItems
      field="camera"
      anyLabel={null}
      buckets={buckets}
      empty="no camera tags (yet)"
    />
  );
}

export function AspectMenuItems() {
  const metas = useCollectionMetas();
  const dims = metas.map(effectiveDims).filter((d): d is Dims => d !== null);
  const buckets = aspectBuckets(dims).flatMap((b) =>
    b.value !== undefined ? [{ label: b.label, value: b.value }] : [],
  );
  return (
    <SelectMenuItems
      field="aspect"
      anyLabel={null}
      buckets={buckets}
      empty="no dimensions read (yet)"
    />
  );
}

export function opHint(input: "date" | "number", op: RangeOp): string {
  if (input === "date") {
    return op === "<=" ? "on or before" : op === "=" ? "on" : "on or after";
  }
  return op === "<=" ? "at most" : op === "=" ? "exactly" : "at least";
}

export function RangeMenuForm({ field, close }: { field: string; close: () => void }) {
  const registered = getFilterField(field);
  const spec = registered?.kind === "range" ? registered.spec : undefined;
  const query = useAppStore((s) => s.query);
  const setRangeFilter = useAppStore((s) => s.setRangeFilter);
  const current = query.filters.find((f) => f.kind === "range" && f.field === field);
  const initial =
    spec && current?.kind === "range"
      ? spec.initial(current)
      : { op: null as RangeOp | null, value: "" };
  const [op, setOp] = useState<RangeOp | null>(initial.op);
  const [value, setValue] = useState(initial.value);

  if (!spec) return null;
  const range = op === null ? null : spec.parse(op, value);

  const apply = () => {
    if (!range) return;
    setRangeFilter(field, range.from, range.to, range.label);
    close();
  };

  return (
    <>
      {spec.ops.map((o) => (
        <button key={o} onClick={() => setOp(o)}>
          {OP_SYMBOL[o]}
          <span className="menu-hint">{opHint(spec.input, o)}</span>
          <span className="menu-check">{op === o ? "✓" : ""}</span>
        </button>
      ))}
      {op !== null && (
        <form
          className="range-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="range-value">
            <input
              type={spec.input}
              step="any"
              min="0"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
            {spec.unit && <span className="range-unit">{spec.unit}</span>}
          </div>
          <button type="submit" className="range-apply" disabled={range === null}>
            Apply
          </button>
        </form>
      )}
    </>
  );
}
