import { CAPTION_CYCLE, CAPTION_LABELS, CAPTION_NOTES, OVERLAY_CYCLE, OVERLAY_LABELS, OVERLAY_NOTES, useDevelopStore } from "../../state/develop";
import { sceneGapLabel, sliderFromTau, tauFromSlider } from "../../state/scenes";
import { useAppStore } from "../../state/store";
import { parseNumber, Slider } from "../shell/Slider";
import { maxColumnsFor } from "./GalleryGrid";

/* Each view's own settings, shown under its row in the view menu. */

function Columns() {
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

export function SceneKnobs() {
  const sceneGapMin = useAppStore((s) => s.sceneGapMin);
  const setSceneGap = useAppStore((s) => s.setSceneGap);
  const contentWeight = useAppStore((s) => s.sceneContentWeight);
  const setContentWeight = useAppStore((s) => s.setSceneContentWeight);
  return (
        <div className="menu-knobs">
          <Columns />
          <Slider
            label="scene break"
            value={sliderFromTau(sceneGapMin)}
            neutral={0}
            min={0}
            max={1}
            step={0.005}
            display={sceneGapLabel(sceneGapMin)}
            parse={(text) => {
              const minutes = parseNumber(text);
              return minutes === null ? null : sliderFromTau(minutes);
            }}
            ticks={[1, 5, 30, 60].map((minutes) => ({
              at: sliderFromTau(minutes),
              title: minutes < 60 ? `${minutes} min` : "an hour",
            }))}
            layout="inline"
            title="how long a pause splits scenes — log scale, 30 s to an hour"
            onChange={(x) => setSceneGap(tauFromSlider(x))}
          />
          <Slider
            label="content"
            value={contentWeight}
            neutral={0}
            min={0}
            max={1}
            step={0.01}
            display={`${Math.round(contentWeight * 100)}%`}
            parse={(text) => {
              const percent = parseNumber(text);
              return percent === null ? null : percent / 100;
            }}
            ticks={[{ at: 0.5, title: "the clock and the pictures, evenly" }]}
            layout="inline"
            title="how much the pictures outvote the clock at scene breaks"
            onChange={setContentWeight}
          />
        </div>
      );
}

export function MosaicKnobs() {
  const rowPx = useAppStore((s) => s.mosaicRowPx);
  const setRowPx = useAppStore((s) => s.setMosaicRowPx);
  const packing = useAppStore((s) => s.mosaicPacking);
  const setPacking = useAppStore((s) => s.setMosaicPacking);
  return (
        <div className="menu-knobs">
          <Slider
            label="row height"
            value={rowPx}
            neutral={80}
            min={80}
            max={360}
            step={1}
            display={`${rowPx} px`}
            parse={parseNumber}
            ticks={[]}
            layout="inline"
            title="how tall the rows aim to be"
            onChange={setRowPx}
          />
          {(
            [
              { value: "order", label: "as sorted", hint: "rows vary a little in scale" },
              { value: "packed", label: "one scale", hint: "reordered locally to fit" },
            ] as const
          ).map((row) => (
            <button key={row.value} onClick={() => setPacking(row.value)}>
              <span>{row.label}</span>
              <span className="menu-hint">{row.hint}</span>
              <span className="menu-check">{packing === row.value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      );
}

export function TimelineKnobs() {
  const orientation = useAppStore((s) => s.timelineOrientation);
  const setTimelineOrientation = useAppStore((s) => s.setTimelineOrientation);
  const thumbPx = useAppStore((s) => s.timelineThumbPx);
  const setTimelineThumbPx = useAppStore((s) => s.setTimelineThumbPx);
  return (
        <div className="menu-knobs">
          {(["vertical", "horizontal"] as const).map((o) => (
            <button key={o} onClick={() => setTimelineOrientation(o)}>
              <span>{o}</span>
              <span className="menu-check">{orientation === o ? "✓" : ""}</span>
            </button>
          ))}
          <Slider
            label="size"
            value={thumbPx}
            neutral={80}
            min={80}
            max={400}
            step={1}
            display={`${thumbPx} px`}
            parse={parseNumber}
            ticks={[]}
            layout="inline"
            title="photo size — the time scale stays put"
            onChange={setTimelineThumbPx}
          />
        </div>
      );
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
