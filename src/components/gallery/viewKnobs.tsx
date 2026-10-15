import { CAPTION_CYCLE, CAPTION_LABELS, CAPTION_NOTES, OVERLAY_CYCLE, OVERLAY_LABELS, OVERLAY_NOTES, useDevelopStore } from "../../state/develop";
import { useAppStore } from "../../state/store";
import { parseNumber, Slider } from "../shell/Slider";
import { maxColumnsFor } from "./GalleryGrid";

/* Each view's own settings, shown under its row in the view menu. */

export function Columns() {
  const gridColumns = useAppStore((s) => s.gridColumns);
  const setGridColumns = useAppStore((s) => s.setGridColumns);
  return(
    <Slider
      label="per row"
      value={gridColumns}
      neutral={2}
      min={2}
      max={maxColumnsFor(window.innerWidth)}
      step={1}
      display={`${gridColumns}`}
      parse={parseNumber}
      ticks={[]}
      layout="inline"
      title="how many photos fill a row"
      onChange={setGridColumns}
    />
  );
}

export function GridKnobs() {
  return <div className="menu-knobs"><Columns /></div>;
}

export function DarkroomKnobs() {
  const caption = useDevelopStore((s) => s.caption);
  const setCaption = useDevelopStore((s) => s.setCaption);
  const overlay = useDevelopStore((s) => s.session?.overlay ?? "none");
  const setOverlay = useDevelopStore((s) => s.setOverlay);
  const gridlines = useDevelopStore((s) => s.gridlines);
  const toggleGridlines = useDevelopStore((s) => s.toggleGridlines);
  return (
        <div className="menu-knobs">
          <span className="menu-section">caption</span>
          {CAPTION_CYCLE.map((mode) => (
            <button key={mode} title={CAPTION_NOTES[mode]} onClick={() => setCaption(mode)}>
              <span>{CAPTION_LABELS[mode]}</span>
              <span className="menu-check">{caption === mode ? "✓" : ""}</span>
            </button>
          ))}
          <span className="menu-section">overlay</span>
          {OVERLAY_CYCLE.map((mode) => (
            <button key={mode} title={OVERLAY_NOTES[mode]} onClick={() => setOverlay(mode)}>
              <span>{OVERLAY_LABELS[mode]}</span>
              <span className="menu-check">{overlay === mode ? "✓" : ""}</span>
            </button>
          ))}
          <button onClick={toggleGridlines}>
            <span>thirds guides</span>
            <span className="menu-check">{gridlines ? "✓" : ""}</span>
          </button>
        </div>
      );
}
