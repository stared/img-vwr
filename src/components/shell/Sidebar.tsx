import { titleWithChord } from "../../registry/keybindings";
import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";
import { SidebarResizer } from "./SidebarResizer";

/**
 * Left sidebar: an icon row picks ONE panel; clicking the active icon
 * collapses to a slim rail, the right bar's grammar mirrored.
 */
export function Sidebar() {
  const visible = useAppStore((s) => s.sidebarVisible);
  const activeId = useAppStore((s) => s.activePanelId);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const width = useAppStore((s) => s.sidebarWidth);
  const panels = allPanels();
  const active = panels.find((p) => p.id === activeId) ?? panels[0];

  if (!visible) {
    return (
      <aside className="sidebar collapsed">
        <button
          className="sidebar-toggle"
          title={titleWithChord("show the sidebar", "sidebar.toggle")}
          onClick={toggleSidebar}
        >
          »
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <SidebarResizer side="left" />
      <nav className="activitybar">
        {panels.map((panel) => (
          <button
            key={panel.id}
            className={panel.id === active?.id ? "active" : ""}
            title={panel.title}
            onClick={() => setActivePanel(panel.id)}
          >
            {panel.icon ?? panel.title[0]}
          </button>
        ))}
        <button
          className="sidebar-toggle"
          title={titleWithChord("hide the sidebar", "sidebar.toggle")}
          onClick={toggleSidebar}
        >
          «
        </button>
      </nav>
      {active && (
        <>
          <header className="sidebar-title">{active.title}</header>
          <div className="panel-body">
            <active.component />
          </div>
        </>
      )}
    </aside>
  );
}
