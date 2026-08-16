import { useEffect, useMemo, type ReactNode } from "react";

import { parseNumber, Slider } from "../shell/Slider";
import { ASPECT_CHOICES, isPortrait } from "../../state/crop";
import { exposureValue, hdrLabel } from "../../state/hdr";
import { groupStacks, siblingsOf, stackKeyOf } from "../../state/stacks";
import { hdrOf, useAppStore, useSelectedEntry } from "../../state/store";
import {
  baselineOf,
  CAPTION_CYCLE,
  CAPTION_LABELS,
  CAPTION_NOTES,
  displayedSize,
  frameAspect,
  FULL_CROP,
  isCropped,
  OVERLAY_CYCLE,
  OVERLAY_LABELS,
  OVERLAY_NOTES,
  isAtOpening,
  PARAM_SPECS,
  presetOf,
  TEMPERATURE_RANGE,
  TINT_RANGE,
  useDevelopStore,
  type ParamSpec,
} from "../../state/develop";
import { DevelopHistogram } from "./DevelopHistogram";
import { DevelopLoupe } from "./DevelopLoupe";

/**
 * A section of the panel, folded and unfolded by its own heading — the same
 * disclosure the sidebar's panels wear, one level down. What is folded stays
 * folded across photographs: it is a statement about the work of the
 * sitting, not about any one image.
 */
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

/**
 * The develop panel: white balance, tone and colour for the selected image,
 * with the histogram of what those settings actually produce.
 *
 * Every control states its current value in words beside its name, so the
 * panel reads as a description of the edit rather than a wall of handles.
 */

export function DevelopPanel() {
  const entry = useSelectedEntry();

  const session = useDevelopStore((s) => s.session);
  const opening = useDevelopStore((s) => s.opening);
  const original = useDevelopStore((s) => s.original);
  const setOriginal = useDevelopStore((s) => s.setOriginal);
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
  // The set this photograph belongs to, from either side: the face fronts
  // it, a member sits inside it. The *outcome* — fused, and which frames
  // made it — comes from the session, because the backend ran the alignment.
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
  const active = presetOf(settings, presets);
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
      {/* First, because it is the one part of the panel that is picture
          rather than controls: pixels you glance at while working. */}
      <Group title="Loupe">
        <div
          className="develop-switch"
          title="actual pixels of one small region; drag the photograph to aim it"
        >
          <span className="develop-switch-label">loupe</span>
          <button
            className={loupe ? "develop-toggle on" : "develop-toggle"}
            onClick={() => !loupe && toggleLoupe()}
          >
            on
          </button>
          <button
            className={loupe ? "develop-toggle" : "develop-toggle on"}
            onClick={() => loupe && toggleLoupe()}
          >
            off
          </button>
        </div>
        <DevelopLoupe />
      </Group>

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

      {/* The HDR set as its files, not as a footnote over the sliders. The
          merge is a row of its own — it is a different photograph from any
          frame — and every original stays checkable, the middle one
          included: its row shows the file the camera wrote even though its
          path opens as the fusion. Fates are per frame because alignment
          is per frame: the merge is the longest run of exposures that
          verified against each other, so any frame — the middle one
          included — can be the one left out. The outcome is the backend's
          word: it ran the alignment, this panel only repeats the
          measurement. */}
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
            {/* How the frames become one photograph. Every option is its
                own button with the active one marked — a click means the
                word on it, never "whatever comes next". */}
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
              // The face gets no special fate: since the merge anchors on
              // whichever run of exposures verified, the middle frame can
              // itself be the one left out.
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
          grid always lists every file the camera wrote. Both options on
          show, the active one marked — no mystery cycling. */}
      {hasStacks && (
        <div className="develop-switch">
          <span className="develop-switch-label">raw + JPG</span>
          <button
            className={stacking ? "develop-toggle on" : "develop-toggle"}
            onClick={() => !stacking && toggleStacking()}
          >
            one photograph
          </button>
          <button
            className={stacking ? "develop-toggle" : "develop-toggle on"}
            onClick={() => stacking && toggleStacking()}
          >
            two files
          </button>
        </div>
      )}
      {hasStacks && stacking && (
        <div
          className="develop-switch"
          title="which of a pair stands for the photograph when you haven't picked one"
        >
          <span className="develop-switch-label">stack shows</span>
          <button
            className={stackLead === "jpg" ? "develop-toggle on" : "develop-toggle"}
            onClick={() => stackLead !== "jpg" && toggleStackLead()}
          >
            JPG
          </button>
          <button
            className={stackLead === "raw" ? "develop-toggle on" : "develop-toggle"}
            onClick={() => stackLead !== "raw" && toggleStackLead()}
          >
            raw
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
      </Group>

      <Group title="Tone">
        {/* Every look on show, the one in effect marked. An edited state
            marks nothing, and clicking a look puts the sliders back to its
            starting point. Sensor pixels only: a preset now selects the
            fitted camera transform, and a finished JPEG already has the
            camera's rendering baked in — offering to apply it again would
            be a row of buttons that do nothing. */}
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
        {/* The frame says what produced its pixels, so the switch from the
            camera's own JPEG to this app's raw develop is stated, never
            inferred. The backend reports it per rendered frame. */}
        {info.needsRender && session.frame && (
          <p className="develop-note">
            {session.frame.source === "cameraJpeg"
              ? "showing the camera's own JPEG — exact until a knob moves"
              : "showing this app's raw develop"}
          </p>
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
      </Group>

      <Group title="View">
        {/* Facts over the photograph. Three states, so the useful middle one
            — say it on arrival, then get out of the way — is reachable. The
            zoom lives on the bar above the picture, where the zooming is. */}
        <div className="develop-switch">
          <span className="develop-switch-label">caption</span>
          {CAPTION_CYCLE.map((mode) => (
            <button
              key={mode}
              className={caption === mode ? "develop-toggle on" : "develop-toggle"}
              title={CAPTION_NOTES[mode]}
              onClick={() => setCaption(mode)}
            >
              {CAPTION_LABELS[mode]}
            </button>
          ))}
        </div>
      </Group>

      <Group title="Analysis">
        {/* The overlays replace what the photograph looks like, so only one
            can be on — which is why they share one row rather than having a
            switch each. */}
        <div className="develop-switch">
          <span className="develop-switch-label">overlay</span>
          {OVERLAY_CYCLE.map((mode) => (
            <button
              key={mode}
              className={overlay === mode ? "develop-toggle on" : "develop-toggle"}
              title={OVERLAY_NOTES[mode]}
              onClick={() => setOverlay(mode)}
            >
              {OVERLAY_LABELS[mode]}
            </button>
          ))}
        </div>
        {/* Guides are geometry, not pixels: independent of the above, and free
            to leave on while you work. */}
        <div className="develop-switch">
          <span className="develop-switch-label">guides</span>
          <button
            className={gridlines ? "develop-toggle" : "develop-toggle on"}
            onClick={() => gridlines && toggleGridlines()}
          >
            off
          </button>
          <button
            className={gridlines ? "develop-toggle on" : "develop-toggle"}
            onClick={() => !gridlines && toggleGridlines()}
          >
            thirds
          </button>
        </div>
      </Group>
    </div>
  );
}
