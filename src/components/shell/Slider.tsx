import { useRef, useState } from "react";

/**
 * The one slider.
 *
 * A continuous quantity gets a continuous control. Offering three sizes as
 * three buttons is not a simplification of "how big" — it is a different,
 * smaller question, and it silently refuses the answer somebody actually
 * wanted.
 *
 * But dragging is only one of the three ways people give a number, and a
 * control that supports only that one is as narrow as the buttons were:
 *
 * - **Drag it** — for "a bit more than that", which is most of the time.
 *   Holding shift makes the drag five times finer, because the last few
 *   percent of an exposure is a different gesture from the first fifty.
 * - **Click a mark** — for the value you were going to pick anyway. The marks
 *   sit on the track, say what they are for on hover, and a press that lands
 *   on one can still become a drag.
 * - **Type it** — for "1600", which no amount of dragging hits reliably and
 *   which is the only sane way to ask for an exact number. The readout is the
 *   field: click it, type, Enter. Escape puts it back.
 *
 * Plus the two things every slider should have and most do not: double-click
 * returns it to its own neutral, and the keyboard drives it once it has focus.
 *
 * The track is ours rather than an `<input type="range">`. Not for looks — the
 * native one is fine — but because a mark drawn on a native track has to
 * choose between being clickable and letting a drag begin on top of it, and
 * that choice should not exist. Owning the pointer means a press on a mark
 * *is* the start of a drag from that mark.
 *
 * Every slider in the app comes through here, which is what keeps them
 * aligned: one track height, one thumb, one place the number sits, one origin
 * the fill grows from. Two layouts, because a panel stacks its controls and a
 * toolbar lays them along a line, and nothing else differs between them.
 */

/** A value worth marking on the track, in the slider's own units. */
export interface SliderTick {
  at: number;
  /** What this value is for. Shown on hover, and read out to assistive tech. */
  title: string;
}

export interface SliderProps {
  label: string;
  value: number;
  /**
   * The value the fill grows from — zero for a bipolar control, the minimum
   * for one that only goes up, the camera's own reading for temperature.
   * Everything about the slider's appearance is relative to it: the bar fills
   * from here, the number brightens only once the value has left it, and a
   * double-click comes back to it.
   */
  neutral: number;
  min: number;
  max: number;
  step: number;
  /** The value in words, as the user would say it. */
  display: string;
  /**
   * What somebody typed, as a value — or null if it is not one.
   *
   * Required rather than optional, because a number you cannot type is a
   * number you cannot state exactly, and every quantity here is one somebody
   * eventually wants to state exactly. `parseNumber` covers the ordinary case.
   */
  parse: (text: string) => number | null;
  /** Values worth a mark. Empty is the ordinary case. */
  ticks: readonly SliderTick[];
  /** `stacked` for a panel, `inline` for a toolbar. */
  layout: "stacked" | "inline";
  title: string;
  onChange: (value: number) => void;
}

/** Where along the track a value sits, as a percentage. */
export function positionOf(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
}

/**
 * The first number in a piece of text, or null.
 *
 * Lenient on purpose: the readout says "2048 px" and "+0.50 EV", and somebody
 * editing one of those in place will leave the unit behind as often as not.
 * Refusing that would be pedantry about a value that was never ambiguous.
 */
export function parseNumber(text: string): number | null {
  const match = /-?\d+(\.\d+)?/.exec(text.replace(/,/g, "."));
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** A value rounded onto the control's own steps, and kept in range. */
export function onStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const stepped = step > 0 ? Math.round((value - min) / step) * step + min : value;
  // Steps are decimal (0.1°, 0.01 EV) and the arithmetic above is binary, so
  // without this a tenth of a degree reads as 8.100000000000001.
  const decimals = step > 0 && step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  const clean = decimals > 0 ? Number(stepped.toFixed(decimals)) : stepped;
  return Math.min(max, Math.max(min, clean));
}

/** How much finer a shift-held drag is. Enough to be a different gesture. */
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
  /* Where the drag began, and what the value was there. A ref because a
   * pointer handler has to know it *now*, and React state is whatever the last
   * render saw — events that arrive in one batch would all read the value
   * from before the drag started. */
  const drag = useRef<{ x: number; from: number } | null>(null);
  /** The readout while it is being typed into. Null when it is a readout. */
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

  /* A mark is where a drag starts from, not a button that ends it: pressing
   * one goes there, and carrying on moving carries on from there. */
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
    // Measured from where the press landed, so a drag begun on a mark starts
    // from that mark — and so holding shift makes the rest of the gesture
    // finer without the thumb jumping away from the pointer.
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
    // Ten steps on shift, so crossing a hundred-point scale is not a hundred
    // keystrokes; the two ends are one key each.
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

  /** Commit what was typed, or put the readout back if it was not a number. */
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
      // Selected on arrival: the point of clicking a readout is to replace it,
      // and sweeping the old value out first is a tax on every single use.
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
        // Typing into a field is not a shortcut: the gallery's bare keys rate
        // photographs, and "5" in here is a five.
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
          /* A mark is part of the line, so it wears the line's colour where it
             sits: the fill's inside the bar, the rail's outside it, and the
             live one's when the value is exactly here. A grey dot on a lit bar
             reads as a hole in the bar. */
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
