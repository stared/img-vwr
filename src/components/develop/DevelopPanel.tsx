import { useEffect, useMemo } from "react";

import { parseNumber, Slider } from "../shell/Slider";
import { ASPECT_CHOICES, isPortrait } from "../../state/crop";
import { groupStacks, siblingsOf } from "../../state/stacks";
import { useAppStore, useSelectedEntry } from "../../state/store";
import {
  baselineOf,
  CAPTION_LABELS,
  CAPTION_NOTES,
  displayedSize,
  frameAspect,
  FULL_CROP,
  isCropped,
  nextCaption,
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

/**
 * The magnification, as the user would say it.
 *
 * "fit" and "100%" are names, not numbers — a photographer asks for the whole
 * frame or for actual pixels, and the percentage that happens to correspond
 * to "the whole frame" in this window is not information. Anything else was
 * arrived at by pinching, and there the number is the only honest answer.
 */
export function zoomLabel(view: { scale: number } | null, fitted: boolean): string {
  if (fitted || !view) return "fit";
  const percent = Math.round(view.scale * 100);
  return percent === 100 ? "100%" : `${percent}%`;
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
  const cropChoice = useDevelopStore((s) => s.cropChoice);
  const setCropChoice = useDevelopStore((s) => s.setCropChoice);
  const toggleCropOrientation = useDevelopStore((s) => s.toggleCropOrientation);
  const straighten = useDevelopStore((s) => s.straighten);
  const allEntries = useAppStore((s) => s.entries);
  const preferMember = useAppStore((s) => s.preferMember);
  const stacking = useAppStore((s) => s.stacking);
  const toggleStacking = useAppStore((s) => s.toggleStacking);
  const stackLead = useAppStore((s) => s.stackLead);
  const toggleStackLead = useAppStore((s) => s.toggleStackLead);
  const loupe = useDevelopStore((s) => s.loupe);
  const toggleLoupe = useDevelopStore((s) => s.toggleLoupe);
  const caption = useDevelopStore((s) => s.caption);
  const setCaption = useDevelopStore((s) => s.setCaption);
  const view = useAppStore((s) => s.viewerView);
  const fitted = useAppStore((s) => s.viewerFitted);
  const zoomFit = useAppStore((s) => s.viewerZoomFit);
  const zoomActual = useAppStore((s) => s.viewerZoomActual);
  // Fit and 100% are the two magnifications worth a control; the button
  // swings between them, and reports anything else you pinched your way to.
  const toggleZoom = () => (fitted ? zoomActual() : zoomFit());

  // Whether stacking has anything to do in this collection at all. A switch
  // for something that never happens is noise, so a folder of single files
  // never shows it.
  const hasStacks = useMemo(
    () => [...groupStacks(allEntries).values()].some((members) => members.length > 1),
    [allEntries],
  );

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
  // What a crop actually produces, in pixels. The one number that says what a
  // trim has cost, and it belongs beside the control that did the trimming.
  const cropped = isCropped(settings.crop);
  const developedSize = displayedSize(info, settings.crop);

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
      {/* And whether a pair is one photograph or two files at all. It lives
          here rather than over the grid because it is a darkroom rule: the
          grid always lists every file the camera wrote. */}
      {hasStacks && (
        <button className="develop-toggle" onClick={toggleStacking}>
          raw + JPG: {stacking ? "one photograph" : "two files"}
        </button>
      )}
      {hasStacks && stacking && (
        <button
          className="develop-toggle"
          onClick={toggleStackLead}
          title="which of a pair stands for the photograph when you haven't picked one"
        >
          stack shows: {stackLead === "jpg" ? "JPG" : "raw"}
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
          parse={parseNumber}
          ticks={[{ at: info.asShot.temperature, title: "as the camera measured it" }]}
          layout="stacked"
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
          layout="stacked"
          title="Green to the left, magenta to the right. The mark is the camera's own reading."
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
          <button
            className="develop-toggle"
            title={active ? active.note : `put every slider back to ${baseline?.label ?? "flat"}`}
            onClick={() => {
              const following = nextPreset(active, baseline, presets);
              if (following) applyPreset(following.id);
            }}
          >
            preset: {active ? active.label : `${baseline?.label ?? "flat"}, edited`}
          </button>
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
              // Typed values are read the way the panel is currently showing
              // them, or "+12" would mean two different edits depending on a
              // switch somewhere else on the panel.
              parse={(text) => {
                const typed = parseNumber(text);
                return typed === null ? null : showDeviation ? from + typed : typed;
              }}
              ticks={from === 0 ? [] : [{ at: from, title: `${baseline?.label ?? "flat"}` }]}
              layout="stacked"
              title={`Double-click to put it back to ${baseline?.label ?? "flat"}.`}
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
          title="Drag the handles to trim, the inside to move it, the outside to draw a new one. Enter keeps the crop, Escape puts back the one you started with."
          onClick={() => setCropping(!cropping)}
        >
          {cropping ? "cropping: Enter when done" : "crop"}
        </button>
        {/* The shapes, as a row: there are seven of them, they are a closed
            set, and which one is on is a fact worth being able to read
            without opening anything. */}
        <div className="develop-choices">
          {ASPECT_CHOICES.map((choice) => (
            <button
              key={choice.id}
              className={
                cropChoice === choice.id ? "develop-choice on" : "develop-choice"
              }
              title={
                choice.id === "original"
                  ? "The frame's own shape."
                  : choice.id === "free"
                    ? "No constraint; every handle moves on its own."
                    : `Held to ${choice.label}`
              }
              onClick={() => setCropChoice(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <button
          className="develop-toggle"
          title="Stand the shape on end. A free crop swaps the extents it has."
          onClick={toggleCropOrientation}
        >
          standing: {isPortrait(settings.crop, frameAspect(info)) ? "portrait" : "landscape"}
        </button>
        {/* Straightening turns the photograph under the rectangle and gives
            back as much of it as still fits inside the frame — so the crop
            gets smaller as the angle grows, and never contains a corner that
            was never photographed. */}
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
          layout="stacked"
          title="Turns the photograph under the rectangle. The crop shrinks to stay inside the frame, so straightening costs edges."
          onChange={straighten}
        />
        <p className="develop-note">
          {developedSize.width} × {developedSize.height} px
          {cropped ? "" : " · the whole frame"}
        </p>
        {cropped && (
          <button className="develop-toggle" onClick={() => setCrop(FULL_CROP)}>
            back to the whole frame
          </button>
        )}
      </section>

      <section className="develop-group">
        <h4>View</h4>
        {/* The magnification, in words, on a button that changes it — the
            same shape as every other state control here. Fit and 100% are the
            two a photographer actually asks for; anything in between you got
            to by pinching, and the button says so rather than pretending. */}
        <button className="develop-toggle" onClick={toggleZoom}>
          zoom: {zoomLabel(view, fitted)}
        </button>
        <button
          className={loupe ? "develop-toggle armed" : "develop-toggle"}
          title="actual pixels of the marked region — drag the photograph to move it"
          onClick={toggleLoupe}
        >
          loupe: {loupe ? "on" : "off"}
        </button>
        {/* Facts over the photograph. Three states, so the useful middle one
            — say it on arrival, then get out of the way — is reachable. */}
        <button
          className="develop-toggle"
          title={CAPTION_NOTES[caption]}
          onClick={() => setCaption(nextCaption(caption))}
        >
          caption: {CAPTION_LABELS[caption]}
        </button>
      </section>

      <section className="develop-group">
        <h4>Analysis</h4>
        {/* One button labelled with the state it is in; clicking moves to the
            next. These replace what the photograph looks like, so only one can
            be on — which is why they share a control rather than having one
            switch each. */}
        <button
          className="develop-toggle"
          title={OVERLAY_NOTES[overlay]}
          onClick={() => setOverlay(nextOverlay(overlay))}
        >
          overlay: {OVERLAY_LABELS[overlay]}
        </button>
        {/* Guides are geometry, not pixels: independent of the above, and free
            to leave on while you work. */}
        <button className="develop-toggle" onClick={toggleGridlines}>
          guides: {gridlines ? "thirds" : "off"}
        </button>
      </section>
    </div>
  );
}
