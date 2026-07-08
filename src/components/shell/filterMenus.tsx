import { useMemo, useState } from "react";

import type { ImageMeta } from "../../ipc";
import type { Dims } from "../../state/derived";
import { effectiveDims } from "../../state/derived";
import type { RangeField, RangeOp } from "../../state/query";
import { activeFormats, dateInputValue, FORMAT_GROUPS, rangeFromInput } from "../../state/query";
import { aspectBuckets, cameraCounts } from "../../state/stats";
import { useAppStore } from "../../state/store";

/**
 * Menu bodies shared by the "+" add-filter menu and by clicking an existing
 * chip to edit it. Value menus offer what is actually present in the current
 * collection; range fields take an operator (≤ = ≥) and a typed value.
 */

/** Multi-toggle format rows; stays open so several groups can be picked. */
export function FormatMenuItems() {
  const query = useAppStore((s) => s.query);
  const toggleFormatFilter = useAppStore((s) => s.toggleFormatFilter);
  const formats = activeFormats(query);
  return (
    <>
      {FORMAT_GROUPS.map((g) => (
        <button key={g.id} onClick={() => toggleFormatFilter(g.id)}>
          {g.label}
          <span className="menu-check">{formats.includes(g.id) ? "✓" : ""}</span>
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

/** Cameras present in the collection, most common first. */
export function CameraMenuItems({ close }: { close: () => void }) {
  const metas = useCollectionMetas();
  const query = useAppStore((s) => s.query);
  const setCameraFilter = useAppStore((s) => s.setCameraFilter);
  const buckets = cameraCounts(metas, 12).filter((b) => b.value !== undefined);
  const active = query.filters.find((f) => f.kind === "camera");
  if (buckets.length === 0) {
    return <span className="menu-empty">no camera tags (yet)</span>;
  }
  return (
    <>
      {buckets.map((b) => (
        <button
          key={b.label}
          onClick={() => {
            if (b.value !== undefined) setCameraFilter(b.value);
            close();
          }}
        >
          {b.label}
          <span className="menu-check">
            {active?.kind === "camera" && active.camera === b.value ? "✓" : ""}
          </span>
        </button>
      ))}
    </>
  );
}

/** Aspect ratios present in the collection, most common first. */
export function AspectMenuItems({ close }: { close: () => void }) {
  const metas = useCollectionMetas();
  const query = useAppStore((s) => s.query);
  const setAspectFilter = useAppStore((s) => s.setAspectFilter);
  const dims = metas.map(effectiveDims).filter((d): d is Dims => d !== null);
  const buckets = aspectBuckets(dims).filter((b) => b.value !== undefined);
  const active = query.filters.find((f) => f.kind === "aspect");
  if (buckets.length === 0) {
    return <span className="menu-empty">no dimensions read (yet)</span>;
  }
  return (
    <>
      {buckets.map((b) => (
        <button
          key={b.label}
          onClick={() => {
            if (b.value !== undefined) setAspectFilter(b.value);
            close();
          }}
        >
          {b.label}
          <span className="menu-check">
            {active?.kind === "aspect" && active.aspect === b.value ? "✓" : ""}
          </span>
        </button>
      ))}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const OP_SYMBOL: Record<RangeOp, string> = { "<=": "≤", "=": "=", ">=": "≥" };

function opsFor(field: RangeField): RangeOp[] {
  // Exact file size is never a useful question; exact day or pixel edge is.
  return field === "size" ? ["<=", ">="] : ["<=", "=", ">="];
}

/** Best-effort prefill when editing an existing range chip. */
function initialInput(
  field: RangeField,
  current: { from: number; to: number } | undefined,
): { op: RangeOp; value: string } {
  if (!current) return { op: ">=", value: "" };
  const isDate = field === "taken" || field === "modified";
  if (current.from === -Infinity) {
    const v = isDate
      ? dateInputValue(current.to - DAY_MS)
      : field === "size"
        ? String(Number(((current.to - 1) / 1e6).toFixed(2)))
        : String(current.to - 1);
    return { op: "<=", value: v };
  }
  const op: RangeOp = current.to === Infinity ? ">=" : "=";
  const v = isDate
    ? dateInputValue(current.from)
    : field === "size"
      ? String(Number((current.from / 1e6).toFixed(2)))
      : String(current.from);
  return { op, value: v };
}

/** Operator + value editor for one range field; Apply sets the clause. */
export function RangeMenuForm({ field, close }: { field: RangeField; close: () => void }) {
  const query = useAppStore((s) => s.query);
  const setRangeFilter = useAppStore((s) => s.setRangeFilter);
  const current = query.filters.find((f) => f.kind === "range" && f.field === field);
  const initial = initialInput(field, current?.kind === "range" ? current : undefined);
  const [op, setOp] = useState<RangeOp>(initial.op);
  const [value, setValue] = useState(initial.value);

  const isDate = field === "taken" || field === "modified";
  const range = rangeFromInput(field, op, value);

  const apply = () => {
    if (!range) return;
    setRangeFilter(field, range.from, range.to, range.label);
    close();
  };

  return (
    <form
      className="range-form"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="range-ops">
        {opsFor(field).map((o) => (
          <button
            key={o}
            type="button"
            className={op === o ? "active" : ""}
            onClick={() => setOp(o)}
          >
            {OP_SYMBOL[o]}
          </button>
        ))}
      </div>
      <div className="range-value">
        <input
          type={isDate ? "date" : "number"}
          step="any"
          min="0"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        {field === "size" && <span className="range-unit">MB</span>}
        {field === "edge" && <span className="range-unit">px</span>}
      </div>
      <button type="submit" className="range-apply" disabled={range === null}>
        Apply
      </button>
    </form>
  );
}
