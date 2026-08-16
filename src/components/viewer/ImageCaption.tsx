import { useEffect, useState } from "react";

import type { FileEntry } from "../../ipc";
import { factLines } from "../../registry/facts";
import { DEFAULT_OVERLAY_FACTS } from "../../facts/builtin";
import { CAPTION_LINGER_MS, useDevelopStore } from "../../state/develop";
import { useAppStore } from "../../state/store";

/**
 * What you are looking at, said over the photograph.
 *
 * Lightroom's Info overlay, and the reason every viewer has one: while
 * working through a shoot the questions "which frame is this" and "what was
 * it shot at" come up constantly, and answering them by moving your eyes to a
 * panel — or worse, opening one — breaks the comparison you were making.
 *
 * Set in white over a soft gradient rather than in a box. A box is a second
 * rectangle competing with the photograph's own; a gradient darkens only what
 * the text needs to be legible against and leaves the frame's edge intact.
 * The filename leads, at the size of a heading, because it is the fact you
 * are most often after; the camera settings follow, quieter.
 *
 * Which facts appear comes from the fact registry, so a plugin that learns to
 * read something new can put it here without this file knowing about it.
 */
export function ImageCaption({ entry }: { entry: FileEntry }) {
  const mode = useDevelopStore((s) => s.caption);
  const meta = useAppStore((s) => s.meta[entry.path]);
  // The camera's own white balance solve, once the develop session for this
  // photograph has loaded it. Guarded by path: the session lags navigation,
  // and a stale one would caption this frame with the previous frame's
  // reading.
  const asShot = useDevelopStore((s) =>
    s.session?.path === entry.path ? s.session.info.asShot : null,
  );
  const [showing, setShowing] = useState(true);

  // Every arrival at a photograph starts the clock again — that is what makes
  // "briefly" mean "when something changed" rather than "for a while after
  // launch". Depending on the path rather than the entry: a rescan hands back
  // a new object for the same file, and re-announcing it would be noise.
  const path = entry.path;
  useEffect(() => {
    if (mode !== "briefly") {
      setShowing(mode === "always");
      return;
    }
    setShowing(true);
    const timer = setTimeout(() => setShowing(false), CAPTION_LINGER_MS);
    return () => clearTimeout(timer);
  }, [path, mode]);

  if (mode === "off") return null;

  const lines = factLines(DEFAULT_OVERLAY_FACTS, { entry, meta, asShot });
  if (lines.length === 0) return null;

  return (
    <div
      className={showing ? "image-caption showing" : "image-caption"}
      // Decoration over a picture: it must never eat a click meant for the
      // photograph underneath, and it is not a thing to tab to.
      aria-hidden
    >
      {lines.map((line) => (
        <p key={line.group} className={`caption-${line.group}`}>
          {line.parts.join(line.group === "exposure" ? "   " : " · ")}
        </p>
      ))}
    </div>
  );
}
