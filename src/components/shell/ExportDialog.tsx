import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { developEditedPaths, developExport, type Exported } from "../../ipc";
import {
  candidatesOf,
  planAll,
  nativeSizeOf,
  QUALITY_MARKS,
  QUALITY_MAX,
  QUALITY_MIN,
  qualityLabel,
  sizeFromSlider,
  sizeLabel,
  sizeMarksFor,
  sizeScaleFor,
  sliderFromSize,
  summaryOf,
  type Candidate,
} from "../../state/export";
import { effectiveDims } from "../../state/derived";
import { chosenEntries, hdrOf, useAppStore } from "../../state/store";
import { parseNumber, Slider } from "./Slider";

type Phase =
  | { kind: "setting-up" }
  | { kind: "running"; done: number; total: number; now: string }
  | { kind: "done"; written: Exported[]; failed: { path: string; error: string }[]; stopped: boolean };

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="export-row">
      <span className="export-row-label">{label}</span>
      <div className="export-row-choices">{children}</div>
    </div>
  );
}

function Choice({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={on ? "export-choice on" : "export-choice"}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ExportDialog() {
  const exportOpen = useAppStore((s) => s.exportOpen);
  const setExportOpen = useAppStore((s) => s.setExportOpen);
  const entries = useAppStore((s) => s.entries);

  const options = useAppStore((s) => s.exportOptions);
  const setOptions = useAppStore((s) => s.setExportOptions);
  const folder = useAppStore((s) => s.exportFolder);
  const setFolder = useAppStore((s) => s.setExportFolder);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "setting-up" });
  /** Set by the Stop button; the loop reads it between files. */
  const stopped = useRef(false);

  // Edits are asked over all stack files, so an edit on the raw counts for the JPEG fronting it.
  useEffect(() => {
    if (!exportOpen) return;
    setPhase({ kind: "setting-up" });
    const state = useAppStore.getState();
    const chosen = chosenEntries(state);
    const all = state.entries;
    let live = true;
    // HDR faces must render regardless of the unedited policy: the file at the path is one exposure of the fusion.
    const hdrFaces = new Set(hdrOf(state).byFace.keys());
    void developEditedPaths(all.map((e) => e.path)).then(
      (edited) => {
        if (live) setCandidates(candidatesOf(chosen, all, new Set(edited), hdrFaces));
      },
      () => {
        if (live) setCandidates(candidatesOf(chosen, all, new Set(), hdrFaces));
      },
    );
    return () => {
      live = false;
    };
  }, [exportOpen, entries]);

  const planned = useMemo(
    () => (candidates ? planAll(candidates, options) : []),
    [candidates, options],
  );

  // Serial on purpose: each render holds a sensor's worth of floats and the pipeline is already parallel inside.
  const run = useCallback(async () => {
    if (folder === null || planned.length === 0) return;
    stopped.current = false;
    const written: Exported[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const [at, item] of planned.entries()) {
      // Stop is honored between files, never mid-write.
      if (stopped.current) break;
      setPhase({ kind: "running", done: at, total: planned.length, now: item.entry.name });
      try {
        written.push(
          await developExport(item.job, {
            folder,
            format: options.format,
            size: options.size,
          }),
        );
      } catch (error) {
        failed.push({ path: item.entry.name, error: String(error) });
      }
    }
    setPhase({ kind: "done", written, failed, stopped: stopped.current });
  }, [folder, planned, options]);

  // Window + capture phase: the gallery's bare keys are global, and Escape would otherwise close the viewer behind this sheet.
  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const editing = document.activeElement?.tagName === "INPUT";
      if (editing || phase.kind === "running") return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setExportOpen(false);
      } else if (e.key === "Enter" && phase.kind === "setting-up") {
        e.preventDefault();
        e.stopPropagation();
        void run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [exportOpen, setExportOpen, phase.kind, run]);

  // Measured over every stack file: the raw a render comes from is usually the larger of the pair.
  const meta = useAppStore((s) => s.meta);
  const native = useMemo(
    () =>
      nativeSizeOf(candidates?.flatMap((c) => c.stack) ?? [], (path) => {
        const entry = meta[path];
        return entry ? effectiveDims(entry) : null;
      }),
    [candidates, meta],
  );
  const scale = useMemo(() => sizeScaleFor(native.longest), [native.longest]);
  const sizeMarks = useMemo(() => sizeMarksFor(scale), [scale]);

  if (!exportOpen) return null;

  const close = () => setExportOpen(false);

  const chooseFolder = async () => {
    const picked = await open({
      directory: true,
      title: "Export to",
      defaultPath: folder ?? undefined,
    });
    if (typeof picked === "string") setFolder(picked);
  };

  const quality = options.format.kind === "jpeg" ? options.format.quality : null;

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="export-sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Export</h3>

        {phase.kind === "setting-up" && (
          <>
            <Row label="format">
              <Choice
                on={options.format.kind === "jpeg"}
                title="What a photograph is shared as."
                onClick={() =>
                  setOptions({ ...options, format: { kind: "jpeg", quality: quality ?? 90 } })
                }
              >
                JPEG
              </Choice>
              <Choice
                on={options.format.kind === "png"}
                title="Lossless, and several times the size. For pixels that will be edited again."
                onClick={() => setOptions({ ...options, format: { kind: "png" } })}
              >
                PNG
              </Choice>
            </Row>

            {options.format.kind === "jpeg" && (
              <Row label="quality">
                <Slider
                  label=""
                  value={quality ?? 90}
                  neutral={QUALITY_MIN}
                  min={QUALITY_MIN}
                  max={QUALITY_MAX}
                  step={1}
                  display={qualityLabel(quality ?? 90)}
                  parse={parseNumber}
                  ticks={QUALITY_MARKS.map((mark) => ({ at: mark.at, title: mark.note }))}
                  layout="inline"
                  title="How hard the JPEG encoder squeezes. The marks are the qualities people actually use; anything between them is a real answer too."
                  onChange={(next) =>
                    setOptions({ ...options, format: { kind: "jpeg", quality: next } })
                  }
                />
              </Row>
            )}

            <Row label="longest edge">
              <Slider
                label=""
                value={sliderFromSize(options.size, scale)}
                neutral={0}
                min={0}
                max={1}
                step={0.001}
                display={sizeLabel(options.size, native)}
                // Typed values are pixels; the track's 0..1 position is an implementation detail of the log scale.
                parse={(text) => {
                  const pixels = parseNumber(text);
                  return pixels === null
                    ? null
                    : sliderFromSize({ kind: "longest", pixels }, scale);
                }}
                ticks={sizeMarks.map((mark) => ({
                  at: sliderFromSize(mark.size, scale),
                  title: mark.note,
                }))}
                layout="inline"
                title="The longest edge of the exported file. Logarithmic, because that is how these numbers are spaced; the track ends at the largest photograph selected, and the last stop is full size."
                onChange={(position) =>
                  setOptions({ ...options, size: sizeFromSlider(position, scale) })
                }
              />
            </Row>

            <Row label="unedited">
              <Choice
                on={options.unedited === "camera-jpg"}
                title="A frame with no edit exports as the JPG the camera wrote beside the raw — copied, not re-encoded, with its metadata intact. Fast, and it is the rendering you already judged the frame by."
                onClick={() => setOptions({ ...options, unedited: "camera-jpg" })}
              >
                the camera's JPG
              </Choice>
              <Choice
                on={options.unedited === "render"}
                title="Develop every frame through the same pipeline, so the whole set matches."
                onClick={() => setOptions({ ...options, unedited: "render" })}
              >
                developed like the rest
              </Choice>
            </Row>

            <p className="export-summary">{summaryOf(planned)}</p>
            {options.format.kind === "png" && options.unedited === "camera-jpg" && (
              <p className="export-note">
                A PNG export develops everything: there is no way to hand over a JPG and
                still write a PNG.
              </p>
            )}

            <div className="export-actions">
              <button type="button" className="export-folder" onClick={() => void chooseFolder()}>
                {folder === null ? "choose a folder…" : `to: ${folder}`}
              </button>
              <button
                type="button"
                className="export-go"
                disabled={folder === null || planned.length === 0}
                onClick={() => void run()}
              >
                Export
              </button>
            </div>
          </>
        )}

        {phase.kind === "running" && (
          <>
            <p className="export-summary">
              {phase.done} of {phase.total} — {phase.now}
            </p>
            <div className="export-progress">
              <span style={{ width: `${(phase.done / Math.max(1, phase.total)) * 100}%` }} />
            </div>
            <div className="export-actions">
              <span className="export-note">writing to {folder}</span>
              <button
                type="button"
                className="export-folder stop"
                onClick={() => {
                  stopped.current = true;
                }}
              >
                stop after this one
              </button>
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <p className="export-summary">
              {phase.written.length} exported
              {phase.failed.length > 0 ? `, ${phase.failed.length} could not be` : ""}
              {phase.stopped ? " — stopped" : ""}
            </p>
            {phase.failed.length > 0 && (
              <ul className="export-failed">
                {phase.failed.map((f) => (
                  <li key={f.path}>
                    {f.path}: {f.error}
                  </li>
                ))}
              </ul>
            )}
            <div className="export-actions">
              {phase.written[0] !== undefined && (
                <button
                  type="button"
                  className="export-folder"
                  title={folder ?? ""}
                  onClick={() => void revealItemInDir(phase.written[0]?.path ?? "")}
                >
                  show in the Finder
                </button>
              )}
              <button
                type="button"
                className="export-folder"
                onClick={() => setPhase({ kind: "setting-up" })}
              >
                export again
              </button>
              <button type="button" className="export-go" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
