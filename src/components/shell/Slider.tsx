import { useRef, useState } from "react";

export interface SliderTick {
  at: number;
  title: string;
}

export interface SliderProps {
  label: string;
  value: number;
  /** The value the fill grows from; double-click returns here. */
  neutral: number;
  min: number;
  max: number;
  step: number;
  display: string;
  parse: (text: string) => number | null;
  ticks: readonly SliderTick[];
  layout: "stacked" | "inline";
  title: string;
  onChange: (value: number) => void;
}

export function positionOf(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
}

/** First number in the text, or null — lenient so a unit left in the readout ("2048 px") still parses. */
export function parseNumber(text: string): number | null {
  const match = /-?\d+(\.\d+)?/.exec(text.replace(/,/g, "."));
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function onStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const stepped = step > 0 ? Math.round((value - min) / step) * step + min : value;
  // Steps are decimal but the arithmetic is binary; without this 8.1 reads as 8.100000000000001.
  const decimals = step > 0 && step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  const clean = decimals > 0 ? Number(stepped.toFixed(decimals)) : stepped;
  return Math.min(max, Math.max(min, clean));
}

const FINE = 0.2;

export function Slider({
  label,
  value,
  neutral,
  min,
  max,
  step,
  display,
  parse,
  ticks,
  layout,
  title,
  onChange,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  // A ref, not state: pointer events batched into one render would all read the pre-drag value.
  const drag = useRef<{ x: number; from: number } | null>(null);
  /** The readout while being typed into; null when showing the value. */
  const [typing, setTyping] = useState<string | null>(null);

  const changed = value !== neutral;
  const here = positionOf(value, min, max);
  const origin = positionOf(neutral, min, max);

  const begin = (e: React.PointerEvent, from: number) => {
    e.preventDefault();
    drag.current = { x: e.clientX, from };
    trackRef.current?.setPointerCapture(e.pointerId);
    trackRef.current?.focus();
    if (from !== value) onChange(from);
  };

  const valueAtX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    const at = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return onStep(min + at * (max - min), min, max, step);
  };

  const handleTrackDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    begin(e, valueAtX(e.clientX));
  };

  // Pressing a mark goes there and can continue as a drag from there.
  const handleTickDown = (tick: SliderTick) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    begin(e, onStep(tick.at, min, max, step));
  };

  const handleMove = (e: React.PointerEvent) => {
    const held = drag.current;
    if (held === null) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    // Delta from the press point, not absolute: shift can turn mid-drag without the thumb jumping to the pointer.
    const moved = ((e.clientX - held.x) / rect.width) * (max - min);
    onChange(onStep(held.from + moved * (e.shiftKey ? FINE : 1), min, max, step));
  };

  const handleUp = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    drag.current = null;
    if (trackRef.current?.hasPointerCapture(e.pointerId) === true) {
      trackRef.current.releasePointerCapture(e.pointerId);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    const jump = e.shiftKey ? step * 10 : step;
    const to =
      e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? value - jump
        : e.key === "ArrowRight" || e.key === "ArrowUp"
          ? value + jump
          : e.key === "Home"
            ? min
            : e.key === "End"
              ? max
              : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(onStep(to, min, max, step));
  };

  const commit = () => {
    if (typing === null) return;
    const parsed = parse(typing);
    setTyping(null);
    if (parsed !== null) onChange(onStep(parsed, min, max, step));
  };

  const readout = (
    <input
      className={changed ? "slider-value changed" : "slider-value"}
      value={typing ?? display}
      title="Type a value"
      spellCheck={false}
      onChange={(e) => setTyping(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setTyping(null);
          e.currentTarget.blur();
        }
        // stopPropagation: the gallery's bare keys are global — "5" typed here must not rate the photograph.
        e.stopPropagation();
      }}
    />
  );

  const marks = ticks.length === 0 ? "" : `\n\nMarks: ${ticks.map((t) => t.title).join("; ")}`;
  const track = (
    <div
      ref={trackRef}
      className="slider-track"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={display}
      title={`${title}${marks}\n\nDrag, or shift-drag for finer. Double-click to reset.`}
      onPointerDown={handleTrackDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onKeyDown={handleKey}
      onDoubleClick={() => onChange(neutral)}
    >
      <span className="slider-rail" />
      <span
        className="slider-fill"
        style={{ left: `${Math.min(here, origin)}%`, right: `${100 - Math.max(here, origin)}%` }}
      />
      {ticks.map((tick) => (
        <button
          key={tick.at}
          type="button"
          className={[
            "slider-tick",
            tick.at >= Math.min(value, neutral) && tick.at <= Math.max(value, neutral)
              ? "filled"
              : "",
            Math.abs(tick.at - value) < step / 2 ? "on" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ left: `${positionOf(tick.at, min, max)}%` }}
          title={tick.title}
          aria-label={tick.title}
          tabIndex={-1}
          onPointerDown={handleTickDown(tick)}
        />
      ))}
      <span className="slider-thumb" style={{ left: `${here}%` }} />
    </div>
  );

  return (
    <div className={`slider ${layout}`}>
      {layout === "stacked" ? (
        <>
          <div className="slider-head">
            {label !== "" && <span className="slider-label">{label}</span>}
            {readout}
          </div>
          {track}
        </>
      ) : (
        <>
          {label !== "" && <span className="slider-label">{label}</span>}
          {track}
          {readout}
        </>
      )}
    </div>
  );
}
