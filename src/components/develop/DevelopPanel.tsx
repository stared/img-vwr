import { useMemo, type ReactNode } from "react";

import { parseNumber, Slider } from "../shell/Slider";
import { ASPECT_CHOICES, isPortrait } from "../../state/crop";
import { exposureValue, hdrLabel } from "../../state/hdr";
import { groupStacks, siblingsOf, stackKeyOf } from "../../state/stacks";
import { hdrOf, useAppStore, useSelectedEntry } from "../../state/store";
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  const folded = useDevelopStore((s) => s.folded[title] === true);
  const toggleFolded = useDevelopStore((s) => s.toggleFolded);
  return (
    <section className="develop-group">
      <h4>
        <button className="develop-fold" onClick={() => toggleFolded(title)}>
          <span className="panel-disclosure">{folded ? "▸" : "▾"}</span>
          {title}
        </button>
      </h4>
      {!folded && children}
    </section>
  );
}

export function DevelopPanel() {
  const entry = useSelectedEntry();

  const session = useDevelopStore((s) => s.session);
  const opening = useDevelopStore((s) => s.opening);
  const original = useDevelopStore((s) => s.original);
  const setOriginal = useDevelopStore((s) => s.setOriginal);
  const setParam = useDevelopStore((s) => s.setParam);
  const setTemperature = useDevelopStore((s) => s.setTemperature);
  const setTint = useDevelopStore((s) => s.setTint);
  const setPicking = useDevelopStore((s) => s.setPicking);
  const reset = useDevelopStore((s) => s.reset);
  const presets = useDevelopStore((s) => s.presets);
  const applyPreset = useDevelopStore((s) => s.applyPreset);
  const showDeviation = useDevelopStore((s) => s.showDeviation);
  const toggleDeviation = useDevelopStore((s) => s.toggleDeviation);
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
  const hdrSet = useAppStore((s) => {
    if (entry === null) return null;
    const hdr = hdrOf(s);
    const direct = hdr.byFace.get(entry.path);
    if (direct !== undefined) return direct;
    const facePath = hdr.keyByStack.get(stackKeyOf(entry));
    return facePath === undefined ? null : (hdr.byFace.get(facePath) ?? null);
  });
  const allMeta = useAppStore((s) => s.meta);
  const hdrMethods = useAppStore((s) => s.hdrMethod);
  const setHdrMethod = useAppStore((s) => s.setHdrMethod);
  const hasStacks = useMemo(
    () => [...groupStacks(allEntries).values()].some((members) => members.length > 1),
    [allEntries],
  );

  // Session lifecycle is owned by App's useDevelopSession; this panel only renders it.
  const isLocal = entry !== null && !entry.path.startsWith("http");

  if (!entry) return <p className="panel-hint">No image selected.</p>;
  if (!isLocal) return <p className="panel-hint">Only local images can be developed.</p>;
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

  return (
    <div className="develop-panel">
      <div className="develop-status">
        <span>
          {comparing ? "before" : ""}
          {session.rendering ? (comparing ? " · rendering…" : "rendering…") : ""}
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

      {hdrSet !== null && (() => {
        const face = hdrSet.face;
        const onFace = entry.path === face.path;
        const outcome = onFace ? info.hdr : null;
        const leftOut = outcome?.kind === "fused" ? new Set(outcome.leftOut) : null;
        const evOf = (path: string) => {
          const exif = allMeta[path]?.exif;
          return exif === undefined || exif === null ? null : exposureValue(exif);
        };
        const faceEv = evOf(face.path);
        const note =
          outcome === null
            ? "showing one frame of the set alone"
            : outcome.kind === "fused"
              ? leftOut !== null && leftOut.size > 0
                ? `${hdrSet.frames.length - leftOut.size} of ${hdrSet.frames.length} frames fused; the misaligned are left out, not ghosted in`
                : `${hdrLabel(hdrSet)} · every frame aligned to the pixel and fused`
              : outcome.kind === "refused"
                ? "no two exposures align with each other; no merge"
                : "opening the fusion…";
        return (
          <Group title="HDR">
            <p
              className="develop-note"
              title={
                outcome?.kind === "refused"
                  ? outcome.reason
                  : "the merge is virtual — nothing is written beside the originals; export renders it"
              }
            >
              {note}
            </p>
            {(() => {
              const method = hdrMethods[face.path] ?? "fusion";
              return (
                <div className="develop-switch">
                  <span className="develop-switch-label">merge by</span>
                  <button
                    className={method === "fusion" ? "develop-toggle on" : "develop-toggle"}
                    title="a blend of each frame's best-exposed pixels: finished, the camera's look, no knobs"
                    onClick={() => setHdrMethod(face.path, "fusion")}
                  >
                    exposure fusion
                  </button>
                  <button
                    className={method === "radiance" ? "develop-toggle on" : "develop-toggle"}
                    title="the light itself, linear, with the dark frames' highlight headroom kept; exposure, highlights and shadows become the HDR knobs"
                    onClick={() => setHdrMethod(face.path, "radiance")}
                  >
                    radiance
                  </button>
                </div>
              );
            })()}
            <button
              className={
                onFace && original !== face.path
                  ? "develop-toggle hdr-frame current"
                  : "develop-toggle hdr-frame"
              }
              title="the fused photograph — virtual, edits and export apply to it"
              onClick={() => {
                preferMember(face.path);
                setOriginal(null);
              }}
            >
              <span className="hdr-frame-name">the merge</span>
              <span className="hdr-frame-ev" />
              <span className="hdr-frame-fate">
                {outcome === null
                  ? `HDR ×${hdrSet.frames.length}`
                  : outcome.kind === "fused"
                    ? leftOut !== null && leftOut.size > 0
                      ? `${hdrSet.frames.length - leftOut.size} of ${hdrSet.frames.length}`
                      : "fused"
                    : outcome.kind === "refused"
                      ? "refused"
                      : "opening…"}
              </span>
            </button>
            {hdrSet.frames.map((frame) => {
              const isFace = frame.path === face.path;
              const ev = evOf(frame.path);
              const step = faceEv === null || ev === null ? null : faceEv - ev;
              // The merge anchors on whichever run of exposures verified, so the face frame itself can be the one left out.
              const fate =
                leftOut !== null
                  ? leftOut.has(frame.path)
                    ? "misaligned"
                    : "fused"
                  : outcome?.kind === "refused"
                    ? isFace
                      ? "shown alone"
                      : "misaligned"
                    : "one exposure";
              const current =
                entry.path === frame.path && (!isFace || original === face.path);
              return (
                <button
                  key={frame.path}
                  className={
                    current ? "develop-toggle hdr-frame current" : "develop-toggle hdr-frame"
                  }
                  title={
                    isFace
                      ? "the frame the camera wrote at the merge's own path — click to check it"
                      : "click to check this frame alone"
                  }
                  onClick={() => {
                    preferMember(frame.path);
                    setOriginal(isFace ? face.path : null);
                  }}
                >
                  <span className="hdr-frame-name">{frame.name}</span>
                  <span className="hdr-frame-ev">
                    {step === null
                      ? ""
                      : `${step > 0 ? "+" : ""}${step.toFixed(1)} EV`}
                  </span>
                  <span className="hdr-frame-fate">{fate}</span>
                </button>
              );
            })}
          </Group>
        );
      })()}

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

      <Group title="White balance">
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
      </Group>

      <Group title="Tone">
        {/* Presets are sensor-pixels only: a finished JPEG already has the camera's rendering baked in. */}
        {presets.length > 0 && info.needsRender && (
          <div className="develop-switch">
            <span className="develop-switch-label">preset</span>
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={
                  active?.id === preset.id ? "develop-toggle on" : "develop-toggle"
                }
                title={preset.note}
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
        {info.needsRender && session.frame && (
          <p className="develop-note">
            {session.frame.source === "cameraJpeg"
              ? "showing the camera's own JPEG — exact until a knob moves"
              : "showing this app's raw develop"}
          </p>
        )}
        {PARAM_SPECS.map((spec: ParamSpec) => {
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
              layout="stacked"
              title={`Double-click to put it back to ${baseline?.label ?? "flat"}.`}
              onChange={(next) => setParam(spec.key, next)}
            />
          );
        })}
        <div className="develop-switch">
          <span className="develop-switch-label">values</span>
          <button
            className={showDeviation ? "develop-toggle on" : "develop-toggle"}
            onClick={() => !showDeviation && toggleDeviation()}
          >
            from {baseline?.label ?? "flat"}
          </button>
          <button
            className={showDeviation ? "develop-toggle" : "develop-toggle on"}
            onClick={() => showDeviation && toggleDeviation()}
          >
            absolute
          </button>
        </div>
      </Group>

      <Group title="Crop">
        <button
          className={cropping ? "develop-toggle armed" : "develop-toggle"}
          title="Drag the handles to trim, the inside to move it, the outside to draw a new one. Enter keeps the crop, Escape puts back the one you started with."
          onClick={() => setCropping(!cropping)}
        >
          {cropping ? "cropping: Enter when done" : "crop"}
        </button>
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
        {(() => {
          const portrait = isPortrait(settings.crop, frameAspect(info));
          return (
            <div
              className="develop-switch"
              title="Stand the shape on end. A free crop swaps the extents it has."
            >
              <span className="develop-switch-label">standing</span>
              <button
                className={portrait ? "develop-toggle" : "develop-toggle on"}
                onClick={() => portrait && toggleCropOrientation()}
              >
                landscape
              </button>
              <button
                className={portrait ? "develop-toggle on" : "develop-toggle"}
                onClick={() => !portrait && toggleCropOrientation()}
              >
                portrait
              </button>
            </div>
          );
        })()}
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
      </Group>

    </div>
  );
}
