import { useMemo, useState } from "react";

import type { ImageMeta } from "../../ipc";
import { getFilterField } from "../../registry/filters";
import type { Dims } from "../../state/derived";
import { effectiveDims } from "../../state/derived";
import type { RangeOp } from "../../state/query";
import { activeFormats, formatChoices } from "../../state/query";
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

export function SelectMenuItems({
  field,
  buckets,
  empty,
  close,
}: {
  field: string;
  buckets: { label: string; value: string }[];
  empty: string;
  close: () => void;
}) {
  const query = useAppStore((s) => s.query);
  const setSelectFilter = useAppStore((s) => s.setSelectFilter);
  const active = query.filters.find((f) => f.kind === "select" && f.field === field);
  if (buckets.length === 0) {
    return <span className="menu-empty">{empty}</span>;
  }
  return (
    <>
      {buckets.map((b) => (
        <button
          key={b.value}
          onClick={() => {
            setSelectFilter(field, b.value);
            close();
          }}
        >
          {b.label}
          <span className="menu-check">
            {active?.kind === "select" && active.value === b.value ? "✓" : ""}
          </span>
        </button>
      ))}
    </>
  );
}

export function CameraMenuItems({ close }: { close: () => void }) {
  const metas = useCollectionMetas();
  const buckets = cameraCounts(metas, 12).flatMap((b) =>
    b.value !== undefined ? [{ label: b.label, value: b.value }] : [],
  );
  return (
    <SelectMenuItems field="camera" buckets={buckets} empty="no camera tags (yet)" close={close} />
  );
}

export function AspectMenuItems({ close }: { close: () => void }) {
  const metas = useCollectionMetas();
  const dims = metas.map(effectiveDims).filter((d): d is Dims => d !== null);
  const buckets = aspectBuckets(dims).flatMap((b) =>
    b.value !== undefined ? [{ label: b.label, value: b.value }] : [],
  );
  return (
    <SelectMenuItems
      field="aspect"
      buckets={buckets}
      empty="no dimensions read (yet)"
      close={close}
    />
  );
}

const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

function opHint(input: "date" | "number", op: RangeOp): string {
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
