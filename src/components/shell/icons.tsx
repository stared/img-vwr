import { IconBrandReddit, IconBrandWikipedia, IconFolder, IconSparkles } from "@tabler/icons-react";
import type { ReactNode } from "react";

const ICON = { size: 18, stroke: 1.7 } as const;

export function FolderIcon() {
  return <IconFolder {...ICON} />;
}

export function SimilarityIcon() {
  return <IconSparkles {...ICON} />;
}

/** Icon per source id; sources without one fall back to their text glyph. */
export const SOURCE_ICONS: Record<string, ReactNode> = {
  reddit: <IconBrandReddit {...ICON} />,
  commons: <IconBrandWikipedia {...ICON} />,
};
