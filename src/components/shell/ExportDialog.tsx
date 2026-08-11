import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";

import { developEditedPaths, developExport, type Exported } from "../../ipc";
import {
  candidatesOf,
  DEFAULT_OPTIONS,
  planAll,
  QUALITY_CHOICES,
  sameSize,
  SIZE_CHOICES,
  summaryOf,
  type Candidate,
  type ExportOptions,
} from "../../state/export";
import { chosenEntries, useAppStore } from "../../state/store";

/**
 * The export sheet: what is about to be written, said before anything is.
 *
 * Every control here is a row of the answers it can have, with the current
 * one lit — the same shape as the develop panel, and for the same reason.
 * There are four of them and they are all enumerable, so a row of buttons
 * says more than a dropdown and costs a click less.
 *
 * The line above the button is the point of the whole dialog. An export of a
 * shoot is mostly frames nobody edited, and whether those come out as the
 * camera's own JPEG or as this app's rendering of the raw is the single
 * decision that changes what lands in the folder. So the sheet counts them,
 * out loud, and re-counts as the options change.
 */

type Phase =
  | { kind: "setting-up" }
  | { kind: "running"; done: number; total: number; now: string }
  | { kind: "done"; written: Exported[]; failed: { path: string; error: string }[] };

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

  const [options, setOptions] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [folder, setFolder] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "setting-up" });

  // Which of the chosen photographs have an edit — the one fact the plan
  // needs that only the database knows. Asked once per opening, over the
  // stack's files rather than the shown one, so an edit made on the raw
  // counts for the JPEG standing in front of it.
  useEffect(() => {
    if (!exportOpen) return;
    setPhase({ kind: "setting-up" });
    const state = useAppStore.getState();
    const chosen = chosenEntries(state);
    const all = state.entries;
    let live = true;
    void developEditedPaths(all.map((e) => e.path)).then(
      (edited) => {
        if (live) setCandidates(candidatesOf(chosen, all, new Set(edited)));
      },
      () => {
        if (live) setCandidates(candidatesOf(chosen, all, new Set()));
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

  if (!exportOpen) return null;

  const close = () => setExportOpen(false);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, title: "Export to" });
    if (typeof picked === "string") setFolder(picked);
  };

  /**
   * The export itself: one file at a time, in the order they are on screen.
   *
   * Serial on purpose. Each render holds a whole sensor's worth of floats and
   * the pipeline is already parallel inside; four at once would compete for
   * the same cores and the same memory, and the only thing gained would be a
   * less honest progress line.
   */
  const run = async () => {
    if (folder === null || planned.length === 0) return;
    const written: Exported[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const [at, item] of planned.entries()) {
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
    setPhase({ kind: "done", written, failed });
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
                {QUALITY_CHOICES.map((choice) => (
                  <Choice
                    key={choice.quality}
                    on={quality === choice.quality}
                    title={`JPEG quality ${choice.quality}`}
                    onClick={() =>
                      setOptions({
                        ...options,
                        format: { kind: "jpeg", quality: choice.quality },
                      })
                    }
                  >
                    {choice.label} ({choice.quality})
                  </Choice>
                ))}
              </Row>
            )}

            <Row label="longest edge">
              {SIZE_CHOICES.map((choice) => (
                <Choice
                  key={choice.label}
                  on={sameSize(options.size, choice.size)}
                  title={choice.note}
                  onClick={() => setOptions({ ...options, size: choice.size })}
                >
                  {choice.label}
                </Choice>
              ))}
            </Row>

            {/* The decision this dialog exists for. */}
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
          </>
        )}

        {phase.kind === "done" && (
          <>
            <p className="export-summary">
              {phase.written.length} exported
              {phase.failed.length > 0 ? `, ${phase.failed.length} could not be` : ""}
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
              {folder !== null && (
                <button
                  type="button"
                  className="export-folder"
                  onClick={() => void revealItemInDir(folder)}
                >
                  show the folder
                </button>
              )}
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
