import { titleWithChord } from "../../registry/keybindings";
import { allPanels } from "../../registry/panels";
import { useAppStore } from "../../state/store";
import { PanelSection } from "./PanelSection";

/** Right-edge counterpart of the sidebar; hosts panels registered with side "right". */
export function RightSidebar() {
  const visible = useAppStore((s) => s.statsVisible);
  const toggleStats = useAppStore((s) => s.toggleStats);
  // `when` guards read these; subscribing keeps the panel set current.
  useAppStore((s) => s.galleryLayout);
  useAppStore((s) => s.viewMode);
  const panels = allPanels("right").filter((p) => p.when?.() ?? true);

  if (panels.length === 0) return null;

  if (!visible) {
    return (
      <aside className="sidebar right collapsed">
        <button
          className="sidebar-toggle"
          title={titleWithChord("show the inspector", "inspector.toggle")}
          onClick={toggleStats}
        >
          «
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar right">
      {panels.map((panel, i) => (
        <PanelSection
          key={panel.id}
          panel={panel}
          action={
            i === 0 ? (
              <button
                className="sidebar-toggle"
                title={titleWithChord("hide the inspector", "inspector.toggle")}
                onClick={toggleStats}
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
