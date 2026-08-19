import { useEffect, useState } from "react";

import type { FileEntry } from "../../ipc";
import { factLines } from "../../registry/facts";
import { DEFAULT_OVERLAY_FACTS } from "../../facts/builtin";
import { CAPTION_LINGER_MS, useDevelopStore } from "../../state/develop";
import { useAppStore } from "../../state/store";

export function ImageCaption({ entry }: { entry: FileEntry }) {
  const mode = useDevelopStore((s) => s.caption);
  const meta = useAppStore((s) => s.meta[entry.path]);
  // Guarded by path: the session lags navigation, and a stale one would caption this frame with the previous frame's reading.
  const asShot = useDevelopStore((s) =>
    s.session?.path === entry.path ? s.session.info.asShot : null,
  );
  const [showing, setShowing] = useState(true);

  // Keyed by path, not entry: a rescan hands back a new object for the same file and would re-announce it.
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
