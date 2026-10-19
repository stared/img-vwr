import { useMemo, useState } from "react";

import type { FileEntry } from "../../ipc";
import { labelsSetStars, labelsToggleTag } from "../../ipc";
import { titleWithChord } from "../../registry/keybindings";
import { filesBehind, useAppStore, useSelectedEntry } from "../../state/store";
import { useLabelsStore } from "./store";
import { TagDot, type TagFill } from "./TagDot";

export function LabelsPanel() {
  const entry = useSelectedEntry();
  const labels = useLabelsStore((s) => (entry ? s.labels[entry.path] : undefined));
  if (!entry) return null;
  const stars = labels?.stars ?? null;

  const rate = async (next: number | null) => {
    const s = useAppStore.getState();
    const files = filesBehind(s, [entry]).map((f) => f.path);
    useLabelsStore.getState().applied(await labelsSetStars(files.length > 0 ? files : [entry.path], next));
  };

  return (
    <div className="shot-panel">
      <span className="info-rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={stars !== null && n <= stars ? "on" : ""}
            title={titleWithChord(
              n === stars ? "click to clear" : `${n} star${n > 1 ? "s" : ""}`,
              `labels.stars.${n === stars ? 0 : n}`,
            )}
            onClick={() => void rate(n === stars ? null : n)}
          >
            ★
          </button>
        ))}
      </span>
      <TagToggles entry={entry} />
    </div>
  );
}

/** Every tag in the folder, alphabetical so toggling never moves a row. */
function TagToggles({ entry }: { entry: FileEntry }) {
  const entries = useAppStore((s) => s.entries);
  const labels = useLabelsStore((s) => s.labels);
  const selection = useAppStore((s) => s.selection);
  const [draft, setDraft] = useState("");
  const known = useMemo(() => {
    const all = new Set<string>();
    for (const e of entries) for (const t of labels[e.path]?.tags ?? []) all.add(t);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [entries, labels]);
  // The whole selection when the shown image is part of it, else the shown image alone.
  const targets = useMemo(() => {
    if (!selection.includes(entry.path)) return [entry];
    const picked = new Set(selection);
    return entries.filter((e) => picked.has(e.path));
  }, [entry, entries, selection]);

  const fillOf = (tag: string): TagFill => {
    const n = targets.filter((e) => labels[e.path]?.tags.includes(tag)).length;
    return n === 0 ? "none" : n === targets.length ? "all" : "some";
  };

  const toggle = async (tag: string) => {
    const s = useAppStore.getState();
    const files = filesBehind(s, targets).map((f) => f.path);
    useLabelsStore.getState().applied(await labelsToggleTag(files, tag));
  };

  return (
    <div className="info-tags">
      {known.map((t) => {
        const fill = fillOf(t);
        return (
          <button
            key={t}
            className={`tag-toggle ${fill}`}
            title={fill === "all" ? `remove ${t}` : `add ${t}`}
            onClick={() => void toggle(t)}
          >
            <TagDot tag={t} fill={fill} />
            {t}
          </button>
        );
      })}
      <input
        className="tag-new"
        value={draft}
        placeholder="+ tag"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            setDraft("");
            e.currentTarget.blur();
          }
          const tag = draft.trim();
          if (e.key !== "Enter" || tag === "") return;
          setDraft("");
          if (fillOf(tag) !== "all") void toggle(tag);
        }}
      />
    </div>
  );
}
