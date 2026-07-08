import { Folder } from "lucide-react";
import { siReddit, siWikimediacommons } from "simple-icons";
import type { ReactNode } from "react";

/**
 * Activity-bar icons: Lucide for UI glyphs (stroke, Linear-style),
 * Simple Icons for brand marks (fill) — Lucide carries no brand logos.
 */

export function FolderIcon() {
  return <Folder size={18} strokeWidth={1.7} />;
}

function BrandIcon({ path }: { path: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  );
}

export function RedditIcon() {
  return <BrandIcon path={siReddit.path} />;
}

export function CommonsIcon() {
  return <BrandIcon path={siWikimediacommons.path} />;
}

/** Brand icon per source id; sources without one fall back to their glyph. */
export const SOURCE_ICONS: Record<string, ReactNode> = {
  reddit: <RedditIcon />,
  commons: <CommonsIcon />,
};
