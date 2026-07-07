import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";

export function Sidebar() {
  const visible = useAppStore((s) => s.sidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  if (!visible) {
    return (
      <aside className="sidebar collapsed">
        <button className="sidebar-toggle" title="Show sidebar (⌘B)" onClick={toggleSidebar}>
          »
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      {allPanels().map((panel, i) => (
        <section key={panel.id} className="sidebar-panel">
          <header>
            <span>{panel.title}</span>
            {i === 0 && (
              <button className="sidebar-toggle" title="Hide sidebar (⌘B)" onClick={toggleSidebar}>
                «
              </button>
            )}
          </header>
          <panel.component />
        </section>
      ))}
    </aside>
  );
}
