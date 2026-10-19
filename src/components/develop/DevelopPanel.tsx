import { useId, useMemo, useState, type ReactNode } from "react";
import { isLocal } from "../../ipc";

import { parseNumber, Slider } from "../shell/Slider";
import { ASPECT_CHOICES, isPortrait } from "../../state/crop";
import { groupStacks, siblingsOf } from "../../state/stacks";
import { useAppStore, useSelectedEntry } from "../../state/store";
import {
  baselineOf,
  displayedSize,
  frameAspect,
  FULL_CROP,
  isCropped,
  isAtOpening,
  PARAM_SPECS,
  presetOf,
  TEMPERATURE_RANGE,
  TINT_RANGE,
  useDevelopStore,
  type ParamSpec,
} from "../../state/develop";

function Group({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const contentId = useId();
  const folded = useDevelopStore((s) => s.folded[title] === true);
  const toggleFolded = useDevelopStore((s) => s.toggleFolded);
  return (
    <section className="develop-group">
      <h4>
        <button className="develop-fold" aria-expanded={!folded} aria-controls={contentId} onClick={() => toggleFolded(title)}>
          <span className="panel-disclosure" aria-hidden="true">{folded ? "▸" : "▾"}</span>
          {title}
        </button>
        {action}
      </h4>
      <div id={contentId} hidden={folded}>{children}</div>
    </section>
  );
}

export function DevelopPanel() {
  const entry = useSelectedEntry();
  const [autoPending, setAutoPending] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [uprightPending, setUprightPending] = useState(false);

  const session = useDevelopStore((s) => s.session);
  const opening = useDevelopStore((s) => s.opening);
  const setParam = useDevelopStore((s) => s.setParam);
  const setTemperature = useDevelopStore((s) => s.setTemperature);
  const setTint = useDevelopStore((s) => s.setTint);
  const setPicking = useDevelopStore((s) => s.setPicking);
  const reset = useDevelopStore((s) => s.reset);
  const presets = useDevelopStore((s) => s.presets);
  const applyPreset = useDevelopStore((s) => s.applyPreset);
  const showDeviation = useDevelopStore((s) => s.showDeviation);
  const toggleDeviation = useDevelopStore((s) => s.toggleDeviation);
  const autoTone = useDevelopStore((s) => s.autoTone);
  const toggleComparing = useDevelopStore((s) => s.toggleComparing);
  const cancelCrop = useDevelopStore((s) => s.cancelCrop);
  const comparing = useDevelopStore((s) => s.comparing);
  const cropping = useDevelopStore((s) => s.cropping);
  const setCropping = useDevelopStore((s) => s.setCropping);
  const setCrop = useDevelopStore((s) => s.setCrop);
  const cropChoice = useDevelopStore((s) => s.cropChoice);
  const setCropChoice = useDevelopStore((s) => s.setCropChoice);
  const toggleCropOrientation = useDevelopStore((s) => s.toggleCropOrientation);
  const straighten = useDevelopStore((s) => s.straighten);
  const setKeystone = useDevelopStore((s) => s.setKeystone);
  const autoUpright = useDevelopStore((s) => s.autoUpright);
  const allEntries = useAppStore((s) => s.entries);
  const preferMember = useAppStore((s) => s.preferMember);
  const stacking = useAppStore((s) => s.stacking);
  const toggleStacking = useAppStore((s) => s.toggleStacking);
  const hasStacks = useMemo(
    () => [...groupStacks(allEntries).values()].some((members) => members.length > 1),
    [allEntries],
  );

  // Session lifecycle is owned by App's useDevelopSession; this panel only renders it.

  if (!entry) return <p className="panel-hint">No image selected.</p>;
  if (!isLocal(entry.path)) return <p className="panel-hint">Only local images can be developed.</p>;
  if (opening !== null) return <p className="panel-hint">Opening {entry.name}…</p>;
  if (!session) return <p className="panel-hint">No develop support for this format.</p>;

  const sibling = siblingsOf(allEntries, entry)[0] ?? null;
  const { settings, info } = session;
  const active = presetOf(settings, presets);
  const baseline = baselineOf(settings, presets);
  // A raw opens with a non-identity look, so "untouched" means at-opening, not the identity edit.
  const untouched = !info.edited && isAtOpening(session);
  const cropped = isCropped(settings.crop);
  const developedSize = displayedSize(info, settings.crop);

  const renderParam = (spec: ParamSpec) => {
    const value = settings.params[spec.key];
    // Slider zero level is the preset baseline, not flat, so double-click returns to the preset.
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
        // Typed values are parsed in the display's current mode, or "+12" would mean two different edits.
        parse={(text) => {
          const typed = parseNumber(text);
          return typed === null ? null : showDeviation ? from + typed : typed;
        }}
        ticks={from === 0 ? [] : [{ at: from, title: `${baseline?.label ?? "flat"}` }]}
        layout="inline"
        title={`Double-click to put it back to ${baseline?.label ?? "flat"}.`}
        onChange={(next) => setParam(spec.key, next)}
      />
    );
  };

  return (
    <div className="develop-panel">
      <div className="develop-toolbar">
        <div className="develop-actions">
          <label className="develop-preview">
            <input type="checkbox" checked={comparing} onChange={toggleComparing} />
            Preview original
          </label>
          <button
            className="develop-reset"
            disabled={untouched}
            onClick={() => void reset()}
            title="Put every control back to what this image opened with"
          >
            Reset
          </button>
        </div>
        {session.rendering && <div className="develop-status" role="status">Updating preview…</div>}
      </div>

      {autoError && <p className="develop-error" role="alert">{autoError}</p>}
      {session.error !== null && <p className="develop-error" role="alert">{session.error}</p>}

      <Group title="Tone" action={
          <button
            className="develop-toggle"
            disabled={autoPending}
            onClick={() => {
              setAutoPending(true);
              setAutoError(null);
              void autoTone()
                .catch(() => setAutoError("Auto tone failed. Please try again."))
                .finally(() => setAutoPending(false));
            }}
            title="Automatically adjust exposure"
          >
            {autoPending ? "Adjusting…" : "Auto"}
          </button>
      }>
        {/* Presets are sensor-pixels only: a finished JPEG already has the camera's rendering baked in. */}
        {presets.length > 0 && info.needsRender && (
          <label className="develop-field">
            <span>Look</span>
            <select value={active?.id ?? ""} onChange={(event) => applyPreset(event.target.value)}>
              <option value="" disabled>Custom</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id} title={preset.note}>{preset.label}</option>
              ))}
            </select>
          </label>
        )}
        {PARAM_SPECS.filter((spec) => spec.key !== "vibrance" && spec.key !== "saturation").map(renderParam)}
      </Group>

      <Group title="Colour">
        <Slider
          label="temperature"
          value={settings.whiteBalance.temperature}
          neutral={info.asShot.temperature}
          min={TEMPERATURE_RANGE.min}
          max={TEMPERATURE_RANGE.max}
          step={TEMPERATURE_RANGE.step}
          display={`${Math.round(settings.whiteBalance.temperature)} K`}
          parse={parseNumber}
          ticks={[{ at: info.asShot.temperature, title: "as the camera measured it" }]}
          layout="inline"
          title="Warm to the right, cool to the left. The mark is the camera's own reading."
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
          parse={parseNumber}
          ticks={[{ at: info.asShot.tint, title: "as the camera measured it" }]}
          layout="inline"
          title="Green to the left, magenta to the right. The mark is the camera's own reading."
          onChange={setTint}
        />
        <button
          className={session.picking ? "develop-toggle armed" : "develop-toggle"}
          aria-pressed={session.picking}
          onClick={() => setPicking(!session.picking)}
        >
          {session.picking ? "Cancel picker" : "Pick neutral colour"}
        </button>
        {session.picking && <p className="develop-note" role="status">Click a grey or white area in the photo.</p>}
        {PARAM_SPECS.filter((spec) => spec.key === "vibrance" || spec.key === "saturation").map(renderParam)}
      </Group>

      <Group title="Crop">
        <button
          className={cropping ? "develop-toggle armed" : "develop-toggle"}
          title="Drag the handles to trim, the inside to move it, the outside to draw a new one. Enter keeps the crop, Escape puts back the one you started with."
          onClick={() => setCropping(!cropping)}
        >
          {cropping ? "Done" : "Crop & straighten"}
        </button>
        <button
          className="develop-toggle"
          disabled={uprightPending}
          onClick={() => {
            // Entered first, so Escape puts back the crop from before the auto.
            if (!cropping) setCropping(true);
            setUprightPending(true);
            setAutoError(null);
            void autoUpright()
              .catch(() => setAutoError("Auto straighten failed. Please try again."))
              .finally(() => setUprightPending(false));
          }}
          title="Make the photograph's straight lines plumb and level: sets straighten, vertical and horizontal, and opens the crop to check them"
        >
          {uprightPending ? "Straightening…" : "Auto straighten"}
        </button>
        {cropping && (
          <>
            <button className="develop-toggle" onClick={cancelCrop}>Cancel</button>
            <p className="develop-note">Drag the handles to crop. Enter keeps changes; Esc cancels.</p>
          </>
        )}
        {cropping && (<>
        <div className="develop-crop-options">
          <label className="develop-field">
            <span>Aspect</span>
            <select value={cropChoice} onChange={(event) => setCropChoice(event.target.value)}>
              {ASPECT_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>{choice.label}</option>
              ))}
            </select>
          </label>
          <button
            className="develop-toggle"
            onClick={toggleCropOrientation}
            title="Swap landscape and portrait"
          >
            {isPortrait(settings.crop, frameAspect(info)) ? "↔ Landscape" : "↕ Portrait"}
          </button>
        </div>
        <Slider
          label="straighten"
          value={settings.crop.angle}
          neutral={0}
          min={-45}
          max={45}
          step={0.1}
          display={`${settings.crop.angle > 0 ? "+" : ""}${settings.crop.angle.toFixed(1)}°`}
          parse={parseNumber}
          ticks={[{ at: 0, title: "as shot" }]}
          layout="inline"
          title="Turns the photograph under the rectangle. The crop shrinks to stay inside the frame, so straightening costs edges."
          onChange={straighten}
        />
        <Slider
          label="vertical"
          value={settings.crop.vertical}
          neutral={0}
          min={-30}
          max={30}
          step={0.1}
          display={`${settings.crop.vertical > 0 ? "+" : ""}${settings.crop.vertical.toFixed(1)}°`}
          parse={parseNumber}
          ticks={[{ at: 0, title: "as shot" }]}
          layout="inline"
          title="How far the camera pointed up (+) or down (−). Turned back, walls and posts stand upright."
          onChange={(vertical) => setKeystone({ vertical, horizontal: settings.crop.horizontal })}
        />
        <Slider
          label="horizontal"
          value={settings.crop.horizontal}
          neutral={0}
          min={-30}
          max={30}
          step={0.1}
          display={`${settings.crop.horizontal > 0 ? "+" : ""}${settings.crop.horizontal.toFixed(1)}°`}
          parse={parseNumber}
          ticks={[{ at: 0, title: "as shot" }]}
          layout="inline"
          title="How far the camera turned left (+) or right (−) of square-on. Turned back, a facing wall runs level."
          onChange={(horizontal) => setKeystone({ vertical: settings.crop.vertical, horizontal })}
        />
        </>)}
        <p className="develop-note">
          {developedSize.width} × {developedSize.height} px
          {cropped ? "" : " · the whole frame"}
        </p>
        {cropped && (
          <button className="develop-toggle" onClick={() => setCrop({ ...FULL_CROP, focal: settings.crop.focal })}>
            Reset crop
          </button>
        )}
      </Group>

      <details className="develop-secondary">
        <summary>Source & display</summary>
      {sibling && (
        <div className="develop-switch" title="which file this photograph shows and edits">
          <span className="develop-switch-label">show</span>
          <button className="develop-toggle on">{entry.formatHint.toUpperCase()}</button>
          <button className="develop-toggle" onClick={() => preferMember(sibling.path)}>
            {sibling.formatHint.toUpperCase()}
          </button>
        </div>
      )}
      {hasStacks && (
        <div
          className="develop-switch"
          title="a raw and the JPG shot beside it: one photograph here and in the viewer, or every file on its own"
        >
          <span className="develop-switch-label">raw + JPG</span>
          <button
            className={stacking ? "develop-toggle on" : "develop-toggle"}
            onClick={() => !stacking && toggleStacking()}
          >
            as one
          </button>
          <button
            className={stacking ? "develop-toggle" : "develop-toggle on"}
            onClick={() => stacking && toggleStacking()}
          >
            apart
          </button>
        </div>
      )}

        {info.needsRender && session.frame && (
          <p className="develop-note">
            {session.frame.source === "cameraJpeg"
              ? "showing the camera's own JPEG — exact until a knob moves"
              : "showing this app's raw develop"}
          </p>
        )}
        <label className="develop-check">
          <input type="checkbox" checked={showDeviation} onChange={toggleDeviation} />
          Values relative to {baseline?.label ?? "flat"}
        </label>
      </details>

    </div>
  );
}
