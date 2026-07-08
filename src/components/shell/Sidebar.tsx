import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";

/**
 * VS Code-style left edge: a narrow activity bar chooses ONE panel; the
 * sidebar shows just that panel. Clicking the active icon again collapses
 * the sidebar (the activity bar always stays).
 */
export function Sidebar() {
  const visible = useAppStore((s) => s.sidebarVisible);
  const activeId = useAppStore((s) => s.activePanelId);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const panels = allPanels();
  const active = panels.find((p) => p.id === activeId) ?? panels[0];

  return (
    <>
      <nav className="activitybar">
        {panels.map((panel) => (
          <button
            key={panel.id}
            className={visible && panel.id === active?.id ? "active" : ""}
            title={panel.title}
            onClick={() => setActivePanel(panel.id)}
          >
            {panel.icon ?? panel.title[0]}
          </button>
        ))}
      </nav>
      {visible && active && (
        <aside className="sidebar">
          <header className="sidebar-title">{active.title}</header>
          <div className="panel-body">
            <active.component />
          </div>
        </aside>
      )}
    </>
  );
}
