import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";

/** Right-edge counterpart of the sidebar; hosts panels registered with side "right". */
export function RightSidebar() {
  const visible = useAppStore((s) => s.statsVisible);
  const toggleStats = useAppStore((s) => s.toggleStats);
  const panels = allPanels("right");

  if (panels.length === 0) return null;

  if (!visible) {
    return (
      <aside className="sidebar right collapsed">
        <button className="sidebar-toggle" title="Show statistics (⌘I)" onClick={toggleStats}>
          «
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar right">
      {panels.map((panel, i) => (
        <section key={panel.id} className="sidebar-panel">
          <header>
            <span>{panel.title}</span>
            {i === 0 && (
              <button className="sidebar-toggle" title="Hide statistics (⌘I)" onClick={toggleStats}>
                »
              </button>
            )}
          </header>
          <panel.component />
        </section>
      ))}
    </aside>
  );
}
