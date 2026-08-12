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

/** A value worth marking on the track, in the slider's own units. */
export interface SliderTick {
  at: number;
  /** Said on hover; the marks themselves stay quiet. */
  title: string;
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
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        // Double-clicking returns the control to its own neutral — the
        // camera's temperature, not the bottom of the scale.
        onDoubleClick={() => onChange(neutral)}
      />
      {ticks.map((tick) => (
        <span
          key={tick.at}
          className="slider-tick"
          title={tick.title}
          style={{ left: `${positionOf(tick.at, min, max)}%` }}
        />
      ))}
    </span>
  );

  return (
    <label className={`slider ${layout}`} title={title}>
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
