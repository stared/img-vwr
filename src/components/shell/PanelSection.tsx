import type { ReactNode } from "react";

import type { Panel } from "../../registry/panels";
import { useAppStore } from "../../state/store";

export function PanelSection({
  panel,
  action,
  move,
}: {
  panel: Panel;
  action?: ReactNode;
  /** Reorder handles, shown on header hover; null = at that edge. */
  move?: { up: (() => void) | null; down: (() => void) | null };
}) {
  const open = useAppStore((s) => !(s.panelFolds[panel.id] ?? false));
  const toggleFold = useAppStore((s) => s.togglePanelFold);
  const fill = panel.fill && open ? " fill" : "";
  return (
    <section className={`sidebar-panel${fill}`}>
      <header>
        <button className="panel-toggle" onClick={() => toggleFold(panel.id)}>
          <span className="panel-disclosure">{open ? "▾" : "▸"}</span>
          {panel.title}
        </button>
        {move && (
          <span className="panel-move">
            <button disabled={move.up === null} title="move up" onClick={move.up ?? undefined}>
              ↑
            </button>
            <button
              disabled={move.down === null}
              title="move down"
              onClick={move.down ?? undefined}
            >
              ↓
            </button>
          </span>
        )}
        {action}
      </header>
      {open && (
        <div className="panel-body">
          <panel.component />
        </div>
      )}
    </section>
  );
}
