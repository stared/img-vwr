import { useState, type ReactNode } from "react";

import type { Panel } from "../../registry/panels";

/**
 * VS Code-style sidebar section: a collapsible header per panel. A `fill`
 * panel takes the remaining height and scrolls its own body, so small
 * panels below it (sources) stay visible under a long folder list.
 */
export function PanelSection({ panel, action }: { panel: Panel; action?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const fill = panel.fill && open ? " fill" : "";
  return (
    <section className={`sidebar-panel${fill}`}>
      <header>
        <button className="panel-toggle" onClick={() => setOpen(!open)}>
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
