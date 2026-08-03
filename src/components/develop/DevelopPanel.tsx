import { useEffect } from "react";

import { siblingsOf } from "../../state/stacks";
import { useAppStore, useSelectedEntry } from "../../state/store";
import {
  baselineOf,
  FULL_CROP,
  isCropped,
  nextOverlay,
  OVERLAY_LABELS,
  OVERLAY_NOTES,
  isAtOpening,
  nextPreset,
  PARAM_SPECS,
  presetOf,
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

/** Where along the track a value sits, as a percentage. */
function positionOf(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
}

function Slider({
  label,
  value,
  neutral,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  /**
   * The untouched value for this control — zero for the tone sliders, the
   * camera's own reading for temperature and tint. Everything about a
   * slider's appearance is relative to it: the track fills from here, and
   * the number brightens only once the value has left it.
   */
  neutral: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const changed = value !== neutral;
  const here = positionOf(value, min, max);
  const origin = positionOf(neutral, min, max);
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
  const presets = useDevelopStore((s) => s.presets);
  const applyPreset = useDevelopStore((s) => s.applyPreset);
  const showDeviation = useDevelopStore((s) => s.showDeviation);
  const toggleDeviation = useDevelopStore((s) => s.toggleDeviation);
  const gridlines = useDevelopStore((s) => s.gridlines);
  const toggleGridlines = useDevelopStore((s) => s.toggleGridlines);
  const comparing = useDevelopStore((s) => s.comparing);
  const cropping = useDevelopStore((s) => s.cropping);
  const setCropping = useDevelopStore((s) => s.setCropping);
  const setCrop = useDevelopStore((s) => s.setCrop);
  const allEntries = useAppStore((s) => s.entries);
  const preferMember = useAppStore((s) => s.preferMember);

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

  // One other file is the ordinary case (raw beside a JPEG); if a stack ever
  // holds more, this offers the first and the rest are reachable with
  // stacking off.
  const sibling = siblingsOf(allEntries, entry)[0] ?? null;
  const { settings, info, overlay } = session;
  const active = presetOf(settings.params, presets);
  const baseline = baselineOf(settings, presets);
  // A raw file opens with a look already on it, so "is this the identity edit"
  // is the wrong question for whether there is anything to undo.
  const untouched = !info.edited && isAtOpening(session);

  return (
    <div className="develop-panel">
      <DevelopHistogram histogram={session.frame?.histogram ?? null} />

      <div className="develop-status">
        <span>
          {info.width} × {info.height}
          {/* An edit that appears to have vanished is alarming, so the panel
              says which of the two you are looking at. */}
          {comparing ? " · before" : ""}
          {session.rendering ? " · rendering…" : ""}
        </span>
        <button
          className="develop-reset"
          disabled={untouched}
          onClick={() => void reset()}
          title="Put every control back to what this image opened with"
        >
          reset
        </button>
      </div>

      {session.error !== null && <p className="develop-error">{session.error}</p>}

      {/* The other file of a pair, named rather than implied. Clicking swaps
          which one the stack shows, so the choice is per photograph — usually
          that the camera got this particular frame right. */}
      {sibling && (
        <button className="develop-toggle" onClick={() => preferMember(sibling.path)}>
          also shot: {sibling.formatHint.toUpperCase()}
        </button>
      )}

      <section className="develop-group">
        <h4>White balance</h4>
        <Slider
          label="temperature"
          value={settings.whiteBalance.temperature}
          neutral={info.asShot.temperature}
          min={TEMPERATURE_RANGE.min}
          max={TEMPERATURE_RANGE.max}
          step={TEMPERATURE_RANGE.step}
          display={`${Math.round(settings.whiteBalance.temperature)} K`}
          onChange={setTemperature}
        />
        <Slider
          label="tint"
          value={settings.whiteBalance.tint}
          neutral={info.asShot.tint}
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
        {/* One button saying which look is in effect; clicking moves to the
            next. Every preset is only a set of slider positions, so the
            sliders below always show exactly what it did. */}
        {presets.length > 0 && (
          <>
            <button
              className="develop-toggle"
              onClick={() => {
                const following = nextPreset(active, baseline, presets);
                if (following) applyPreset(following.id);
              }}
            >
              preset: {active ? active.label : `${baseline?.label ?? "flat"}, edited`}
            </button>
            <p className="develop-note">
              {active
                ? active.note
                : `Click to put every slider back to ${baseline?.label ?? "flat"}.`}
            </p>
          </>
        )}
        {PARAM_SPECS.map((spec: ParamSpec) => {
          const value = settings.params[spec.key];
          // Zero level is the preset, not the bottom of the scale. So an
          // untouched image shows bare hairlines however strong its look is,
          // any bar at all means the user moved that control, and
          // double-clicking puts it back to the preset rather than to flat.
          const from = baseline ? baseline.params[spec.key] : 0;
          return (
            <Slider
              key={spec.key}
              label={spec.label}
              value={value}
              neutral={from}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              display={showDeviation ? spec.format(value - from) : spec.format(value)}
              onChange={(next) => setParam(spec.key, next)}
            />
          );
        })}
        {/* The numbers can read either way; the bars always show the
            deviation, because that is what there is to see. */}
        <button className="develop-toggle" onClick={toggleDeviation}>
          values: {showDeviation ? `from ${baseline?.label ?? "flat"}` : "absolute"}
        </button>
      </section>

      <section className="develop-group">
        <h4>Crop</h4>
        <button
          className={cropping ? "develop-toggle armed" : "develop-toggle"}
          onClick={() => setCropping(!cropping)}
        >
          {cropping ? "cropping: drag across the image" : "crop"}
        </button>
        <Slider
          label="straighten"
          value={settings.crop.angle}
          neutral={0}
          min={-45}
          max={45}
          step={0.1}
          display={`${settings.crop.angle > 0 ? "+" : ""}${settings.crop.angle.toFixed(1)}°`}
          onChange={(angle) => setCrop({ ...settings.crop, angle })}
        />
        {isCropped(settings.crop) && (
          <button className="develop-toggle" onClick={() => setCrop(FULL_CROP)}>
            back to the whole frame
          </button>
        )}
      </section>

      <section className="develop-group">
        <h4>Analysis</h4>
        {/* One button labelled with the state it is in; clicking moves to the
            next. These replace what the photograph looks like, so only one can
            be on — which is why they share a control rather than having one
            switch each. */}
        <button className="develop-toggle" onClick={() => setOverlay(nextOverlay(overlay))}>
          overlay: {OVERLAY_LABELS[overlay]}
        </button>
        <p className="develop-note">{OVERLAY_NOTES[overlay]}</p>
        {/* Guides are geometry, not pixels: independent of the above, and free
            to leave on while you work. */}
        <button className="develop-toggle" onClick={toggleGridlines}>
          guides: {gridlines ? "thirds" : "off"}
        </button>
      </section>
    </div>
  );
}
