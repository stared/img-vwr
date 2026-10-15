import type { ComponentType } from "react";

/** Where a badge is drawn: over a gallery cell, or in the status bar for the lead photograph. */
export type BadgePlace = "cell" | "status";

/** A small mark a feature puts on photographs; renders null when it has nothing to say. */
export interface Badge {
  id: string;
  component: ComponentType<{ path: string; place: BadgePlace }>;
}

const registry = new Map<string, Badge>();

export function registerBadge(badge: Badge): void {
  if (registry.has(badge.id)) {
    throw new Error(`badge already registered: ${badge.id}`);
  }
  registry.set(badge.id, badge);
}

export function PhotoBadges({ path, place }: { path: string; place: BadgePlace }) {
  return (
    <>
      {[...registry.values()].map(({ id, component: Component }) => (
        <Component key={id} path={path} place={place} />
      ))}
    </>
  );
}
