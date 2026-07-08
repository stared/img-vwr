import { Folder, Globe, Rss } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Activity-bar icons: all Lucide, all stroke — one visual style. Sources
 * get simple evocative glyphs rather than busy brand logos (the tooltip
 * names them): Reddit is read as a feed, Commons is the world's media.
 */

const ICON = { size: 18, strokeWidth: 1.7 } as const;

export function FolderIcon() {
  return <Folder {...ICON} />;
}

/** Icon per source id; sources without one fall back to their text glyph. */
export const SOURCE_ICONS: Record<string, ReactNode> = {
  reddit: <Rss {...ICON} />,
  commons: <Globe {...ICON} />,
};
