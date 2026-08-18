import type { ReactNode } from "react";

import type { Panel } from "../../registry/panels";
import { useAppStore } from "../../state/store";

/**
 * VS Code-style sidebar section: a collapsible header per panel. A `fill`
 * panel takes the remaining height and scrolls its own body, so small
 * panels below it (sources) stay visible under a long folder list.
 */
export function PanelSection({ panel, action }: { panel: Panel; action?: ReactNode }) {
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
