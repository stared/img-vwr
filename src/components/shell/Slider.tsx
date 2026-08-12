/**
 * The one slider.
 *
 * A continuous quantity gets a continuous control. Offering three sizes as
 * three buttons is not a simplification of "how big" — it is a different,
 * smaller question, and it silently refuses the answer somebody actually
 * wanted. So anything that varies smoothly is dragged, and the value is
 * always written out beside the label, because a handle on a track without a
 * number is a control you can operate but not read.
 *
 * Where a few values *are* special — a quality everyone uses, the size a site
 * wants — they are marks on the track rather than the only options. You can
 * land on them, and you can land between them.
 *
 * Every slider in the app comes through here, which is what keeps them
 * aligned: one track height, one thumb, one place the number sits, one origin
 * the fill grows from. Two layouts, because a panel stacks its controls and a
 * toolbar lays them along a line, and nothing else differs between them.
 */

/**
 * A value worth marking on the track, in the slider's own units.
 *
 * A mark is a shortcut, not a stop: land on it by clicking it or by dragging
 * onto it, and nothing prevents the thumb sitting between two.
 *
 * The mark is drawn *on* the track — that is where the value it names is —
 * and the interaction is a snap rather than a button, which is what lets it be
 * both. A button on the track would take the pointer, and a press that landed
 * on a mark would then be a press that could not become a drag.
 */
export interface SliderTick {
  at: number;
  /** What this value is for; named in the control's own tooltip. */
  title: string;
}

/**
 * How close counts as landed on a mark, as a share of the whole track.
 *
 * Small enough that the value beside a mark is still reachable — at 1.5% of a
 * 40–100 quality scale that is a hair under one point, so 89 and 91 are both
 * yours — and large enough that letting go anywhere near 2048 px gives you
 * 2048 px rather than 2032.
 */
const SNAP = 0.015;

/** The value a raw slider position becomes, once the marks have had their
 * say. Exported for the test that pins the behaviour down. */
export function snapped(value: number, ticks: readonly SliderTick[], span: number): number {
  if (span <= 0) return value;
  let best: SliderTick | null = null;
  for (const tick of ticks) {
    const distance = Math.abs(tick.at - value);
    if (distance <= span * SNAP && (best === null || distance < Math.abs(best.at - value))) {
      best = tick;
    }
  }
  return best === null ? value : best.at;
}

export interface SliderProps {
  label: string;
  value: number;
  /**
   * The value the fill grows from — zero for a bipolar control, the minimum
   * for one that only goes up, the camera's own reading for temperature.
   * Everything about the slider's appearance is relative to it: the bar fills
   * from here, and the number brightens only once the value has left it.
   */
  neutral: number;
  min: number;
  max: number;
  step: number;
  /** The value in words, as the user would say it. */
  display: string;
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

export function Slider({
  label,
  value,
  neutral,
  min,
  max,
  step,
  display,
  ticks,
  layout,
  title,
  onChange,
}: SliderProps) {
  const changed = value !== neutral;
  const here = positionOf(value, min, max);
  const origin = positionOf(neutral, min, max);
  // An empty label means the control already sits under one — the export
  // sheet's rows name their own. The span is dropped rather than left blank so
  // it cannot push the value out of line with the row above.
  const named = label !== "";
  const head = (
    <>
      {named && <span className="slider-label">{label}</span>}
      <span className={changed ? "slider-value changed" : "slider-value"}>{display}</span>
    </>
  );
  const track = (
    <span className="slider-track">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={
          {
            "--fill-a": `${Math.min(here, origin)}%`,
            "--fill-b": `${Math.max(here, origin)}%`,
          } as React.CSSProperties
        }
        onChange={(e) => onChange(snapped(Number(e.currentTarget.value), ticks, max - min))}
        // Double-clicking returns the control to its own neutral — the
        // camera's temperature, not the bottom of the scale.
        onDoubleClick={() => onChange(neutral)}
      />
      {/* Drawn under the input rather than over it: the input keeps every
          pointer event, so a press that lands on a mark is still a press that
          can become a drag, and the thumb passes in front of a mark instead
          of disappearing behind it. */}
      {ticks.map((tick) => (
        <span
          key={tick.at}
          className={
            Math.abs(tick.at - value) < (max - min) * 1e-6 ? "slider-tick on" : "slider-tick"
          }
          style={{ left: `${positionOf(tick.at, min, max)}%` }}
        />
      ))}
    </span>
  );

  const marks = ticks.length === 0 ? "" : `\n\nMarks: ${ticks.map((t) => t.title).join("; ")}`;
  return (
    <label className={`slider ${layout}`} title={`${title}${marks}`}>
      {layout === "stacked" ? (
        <>
          <span className="slider-head">{head}</span>
          {track}
        </>
      ) : (
        <>
          {named && <span className="slider-label">{label}</span>}
          {track}
          <span className={changed ? "slider-value changed" : "slider-value"}>{display}</span>
        </>
      )}
    </label>
  );
}
