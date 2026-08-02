import { useEffect } from "react";

import { useSelectedEntry } from "../../state/store";
import {
  isNeutral,
  PARAM_SPECS,
  TEMPERATURE_RANGE,
  TINT_RANGE,
  useDevelopStore,
  type ParamSpec,
} from "../../state/develop";
import { DevelopHistogram } from "./DevelopHistogram";

/**
 * The develop panel: white balance, tone and colour for the selected image,
 * with the histogram of what those settings actually produce.
 *
 * Every control states its current value in words beside its name, so the
 * panel reads as a description of the edit rather than a wall of handles.
 */

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const changed = display !== "0" && display !== "+0.00 EV";
  return (
    <label className="develop-slider">
      <span className="develop-slider-head">
        <span className="develop-slider-label">{label}</span>
        <span className={changed ? "develop-slider-value changed" : "develop-slider-value"}>
          {display}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        // Double-clicking a slider returns it to its neutral position, the
        // same gesture the viewer uses to return to fit.
        onDoubleClick={() => onChange(0)}
      />
    </label>
  );
}

export function DevelopPanel() {
  const entry = useSelectedEntry();

  const session = useDevelopStore((s) => s.session);
  const opening = useDevelopStore((s) => s.opening);
  const open = useDevelopStore((s) => s.open);
  const close = useDevelopStore((s) => s.close);
  const setParam = useDevelopStore((s) => s.setParam);
  const setTemperature = useDevelopStore((s) => s.setTemperature);
  const setTint = useDevelopStore((s) => s.setTint);
  const setOverlay = useDevelopStore((s) => s.setOverlay);
  const setPicking = useDevelopStore((s) => s.setPicking);
  const reset = useDevelopStore((s) => s.reset);

  // Follow the selection. Remote entries have no local file to develop.
  const path = entry?.path;
  const isLocal = path !== undefined && !path.startsWith("http");
  useEffect(() => {
    if (path === undefined || !isLocal) {
      close();
      return;
    }
    void open(path);
  }, [path, isLocal, open, close]);

  if (!entry) return <p className="panel-hint">No image selected.</p>;
  if (!isLocal) return <p className="panel-hint">Only local images can be developed.</p>;
  if (opening !== null) return <p className="panel-hint">Opening {entry.name}…</p>;
  if (!session) return <p className="panel-hint">No develop support for this format.</p>;

  const { settings, info, overlay } = session;
  const neutral = isNeutral(session);

  return (
    <div className="develop-panel">
      <DevelopHistogram histogram={session.frame?.histogram ?? null} />

      <div className="develop-status">
        <span>
          {info.width} × {info.height}
          {session.rendering ? " · rendering…" : ""}
        </span>
        <button
          className="develop-reset"
          disabled={neutral && !info.edited}
          onClick={() => void reset()}
          title="Return every control to the camera's own settings"
        >
          reset
        </button>
      </div>

      {session.error !== null && <p className="develop-error">{session.error}</p>}

      <section className="develop-group">
        <h4>White balance</h4>
        <Slider
          label="temperature"
          value={settings.whiteBalance.temperature}
          min={TEMPERATURE_RANGE.min}
          max={TEMPERATURE_RANGE.max}
          step={TEMPERATURE_RANGE.step}
          display={`${Math.round(settings.whiteBalance.temperature)} K`}
          onChange={setTemperature}
        />
        <Slider
          label="tint"
          value={settings.whiteBalance.tint}
          min={TINT_RANGE.min}
          max={TINT_RANGE.max}
          step={TINT_RANGE.step}
          display={`${settings.whiteBalance.tint > 0 ? "+" : ""}${Math.round(
            settings.whiteBalance.tint,
          )}`}
          onChange={setTint}
        />
        {/* One button saying what state it is in; clicking arms or disarms. */}
        <button
          className={session.picking ? "develop-toggle armed" : "develop-toggle"}
          onClick={() => setPicking(!session.picking)}
        >
          {session.picking ? "picking: click something grey" : "pick a neutral point"}
        </button>
        <p className="develop-note">
          as shot: {Math.round(info.asShot.temperature)} K, tint{" "}
          {Math.round(info.asShot.tint)}
        </p>
      </section>

      <section className="develop-group">
        <h4>Tone</h4>
        {PARAM_SPECS.map((spec: ParamSpec) => (
          <Slider
            key={spec.key}
            label={spec.label}
            value={settings.params[spec.key]}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            display={spec.format(settings.params[spec.key])}
            onChange={(value) => setParam(spec.key, value)}
          />
        ))}
      </section>

      <section className="develop-group">
        <h4>Analysis</h4>
        {/* One button labelled with the state it is in; clicking switches. */}
        <button
          className="develop-toggle"
          onClick={() => setOverlay(overlay === "sharpness" ? "none" : "sharpness")}
        >
          focus map: {overlay === "sharpness" ? "on" : "off"}
        </button>
        <p className="develop-note">
          Marks the regions that resolve fine detail. Smooth surfaces read as
          unsharp because there is no detail there to resolve.
        </p>
      </section>
    </div>
  );
}
