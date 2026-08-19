import { titleWithChord } from "../../registry/keybindings";
import { allPanels, type Panel } from "../../registry/panels";
import { useDevelopStore } from "../../state/develop";
import { useAppStore } from "../../state/store";
import { PanelSection } from "./PanelSection";
import { SidebarResizer } from "./SidebarResizer";

function ordered(panels: Panel[], order: string[]): Panel[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...panels].sort(
    (a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
  );
}

export function RightSidebar() {
  const visible = useAppStore((s) => s.inspectorVisible);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const order = useAppStore((s) => s.panelOrder);
  const setPanelOrder = useAppStore((s) => s.setPanelOrder);
  const width = useAppStore((s) => s.rightbarWidth);
  // Bare subscriptions: `when` guards read this state via getState(), so subscribe to keep the section set current.
  useAppStore((s) => s.galleryLayout);
  useAppStore((s) => s.viewMode);
  useAppStore((s) => s.selectedIndex !== null);
  useDevelopStore((s) => s.session !== null);

  const all = ordered(allPanels("right"), order);
  const panels = all.filter((p) => p.when?.() ?? true);

  if (all.length === 0) return null;

  if (!visible) {
    return (
      <aside className="sidebar right collapsed">
        <button
          className="sidebar-toggle"
          title={titleWithChord("show the inspector", "inspector.toggle")}
          onClick={toggleInspector}
        >
          «
        </button>
      </aside>
    );
  }

  // Moving swaps with the neighbor as displayed; hidden sections keep their stored slot.
  const move = (id: string, dir: -1 | 1) => {
    const shown = panels.map((p) => p.id);
    const at = shown.indexOf(id);
    const neighbor = shown[at + dir];
    if (neighbor === undefined) return;
    const full = all.map((p) => p.id).filter((x) => x !== id);
    full.splice(full.indexOf(neighbor) + (dir > 0 ? 1 : 0), 0, id);
    setPanelOrder(full);
  };

  return (
    <aside className="sidebar right" style={{ width }}>
      <SidebarResizer side="right" />
      {panels.map((panel, i) => (
        <PanelSection
          key={panel.id}
          panel={panel}
          move={{
            up: i > 0 ? () => move(panel.id, -1) : null,
            down: i < panels.length - 1 ? () => move(panel.id, 1) : null,
          }}
          action={
            i === 0 ? (
              <button
                className="sidebar-toggle"
                title={titleWithChord("hide the inspector", "inspector.toggle")}
                onClick={toggleInspector}
              >
                »
              </button>
            ) : undefined
          }
        />
      ))}
    </aside>
  );
}
