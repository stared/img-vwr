import { parseNumber, Slider } from "../../components/shell/Slider";
import { registerView } from "../../registry/views";
import { useTimelineSettings } from "./settings";
import "./timeline.css";
import { TimelineGallery } from "./TimelineGallery";

function TimelineKnobs() {
  const orientation = useTimelineSettings((s) => s.orientation);
  const setTimelineOrientation = (o: "vertical" | "horizontal") => useTimelineSettings.setState({ orientation: o });
  const thumbPx = useTimelineSettings((s) => s.thumbPx);
  const setTimelineThumbPx = (px: number) => useTimelineSettings.setState({ thumbPx: px });
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

export function registerTimeline(): void {
  registerView({
    id: "timeline",
    label: "Timeline",
    hint: "photographs positioned by capture time",
    component: TimelineGallery,
    keywords: ["date", "taken", "time", "chronological"],
    zoomable: false,
    stacks: false,
    Knobs: TimelineKnobs,
  });
}
