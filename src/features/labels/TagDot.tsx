import type { BadgePlace } from "../../registry/badges";
import { useAppStore } from "../../state/store";
import { useLabelsStore } from "./store";

/** Stable per name, so a tag keeps its color across sessions and folders. */
function tagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 75% 60%)`;
}

/** How many of the photographs in question carry the tag. */
export type TagFill = "all" | "some" | "none";

export function TagDot({ tag, fill }: { tag: string; fill: TagFill }) {
  return <span className={`tag-dot ${fill}`} style={{ color: tagColor(tag) }} />;
}

/** Stars then tags: dots on a cell (a tag the active filter already demands is omitted as redundant), named in the status bar. */
export function LabelsBadge({ path, place }: { path: string; place: BadgePlace }) {
  const labels = useLabelsStore((s) => s.labels[path]);
  const filtered = useAppStore((s) => s.query.filters);
  const stars = labels?.stars ?? null;
  const all = labels?.tags ?? [];
  if (place === "status") {
    if (stars === null && all.length === 0) return null;
    return (
      <span className="status-labels">
        {stars !== null && <span className="status-stars">{"★".repeat(stars)}</span>}
        {all.map((t) => (
          <span key={t}>
            <TagDot tag={t} fill="all" />
            {t}
          </span>
        ))}
      </span>
    );
  }
  const tags = all.filter(
    (t) => !filtered.some((f) => f.kind === "select" && f.field === "tag" && f.value === t),
  );
  if (stars === null && tags.length === 0) return null;
  return (
    <span className="thumb-labels">
      {stars !== null && "★".repeat(stars)}
      {tags.length > 0 && (
        <span className="thumb-tags" title={tags.join(", ")}>
          {tags.map((t) => (
            <TagDot key={t} tag={t} fill="all" />
          ))}
        </span>
      )}
    </span>
  );
}
