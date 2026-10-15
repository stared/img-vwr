import { settingsStore } from "../../state/settingsStore";

export const useTimelineSettings = settingsStore(
  "imgvwr.timeline.v1",
  {
    orientation: "vertical" as "vertical" | "horizontal",
    /** Photo size, px; the time scale stays put. */
    thumbPx: 64,
  },
  { orientation: ["vertical", "horizontal"] },
  { orientation: "timelineOrientation", thumbPx: "timelineThumbPx" },
);
