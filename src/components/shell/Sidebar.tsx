import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";

export function Sidebar() {
  const visible = useAppStore((s) => s.sidebarVisible);
  if (!visible) return null;

  return (
    <aside className="sidebar">
      {allPanels().map((panel) => (
        <section key={panel.id} className="sidebar-panel">
          <header>
            <span className="panel-icon">{panel.icon}</span>
            {panel.title}
          </header>
          <panel.component />
        </section>
      ))}
    </aside>
  );
}
