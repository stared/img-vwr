import { useAppStore } from "../../state/store";

/** Drag handle on a sidebar's inner edge; double-click resets the width. */
export function SidebarResizer({ side }: { side: "left" | "right" }) {
  const set = useAppStore((s) => (side === "left" ? s.setSidebarWidth : s.setRightbarWidth));
  return (
    <div
      className={`sidebar-resizer ${side}`}
      title="drag to resize — double-click resets"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        set(side === "left" ? e.clientX : window.innerWidth - e.clientX);
      }}
      onDoubleClick={() => set(side === "left" ? 230 : 310)}
    />
  );
}
