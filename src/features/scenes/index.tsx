import { useEffect, useMemo } from "react";

import { GalleryGrid, type GridGroup } from "../../components/gallery/GalleryGrid";
import { Columns } from "../../components/gallery/viewKnobs";
import { parseNumber, Slider } from "../../components/shell/Slider";
import { api, type FileEntry } from "../../ipc";
import { registerView } from "../../registry/views";
import { useAppStore } from "../../state/store";
import { registerSceneCommands } from "./commands";
import { useSceneRefinement } from "./refinement";
import { groupScenes, sceneGapLabel, sceneLabel, sliderFromTau, tauFromSlider } from "./scenes";
import { useSceneSettings, useSceneSims } from "./store";

/** Moments inferred from capture time, sharpened by picture content once a model is loaded. */
function useSceneGroups(entries: FileEntry[]): GridGroup[] {
  const epoch = useAppStore((s) => s.epoch);
  const status = useAppStore((s) => s.status);
  const remote = useAppStore((s) => s.scope?.kind === "source");
  const allEntries = useAppStore((s) => s.entries);
  const meta = useAppStore((s) => s.meta);
  const gapMin = useSceneSettings((s) => s.gapMin);
  const contentWeight = useSceneSettings((s) => s.contentWeight);
  const sims = useSceneSims((s) => s.sims);
  useSceneRefinement(entries);

  // getState() keeps received meta out of the effect's deps, so streaming results don't re-fire the request.
  useEffect(() => {
    if (status !== "loaded" || remote || allEntries.length === 0) return;
    const have = useAppStore.getState().meta;
    const missing = allEntries.filter((e) => !(e.path in have)).map((e) => e.path);
    if (missing.length > 0) void api.requestMeta(missing, epoch);
  }, [status, remote, allEntries, epoch]);

  return useMemo(() => {
    // Bands count only for the exact list they were computed for.
    const bands = sims !== null && sims.entries === entries ? sims.bands : null;
    const scenes = groupScenes(entries, meta, gapMin * 60_000, contentWeight, bands);
    return scenes.map((scene, i) => ({
      label: sceneLabel(scene, scenes[i - 1] ?? null, scene.end - scene.start),
      start: scene.start,
      end: scene.end,
    }));
  }, [entries, meta, gapMin, contentWeight, sims]);
}

export function SceneKnobs() {
  const sceneGapMin = useSceneSettings((s) => s.gapMin);
  const setSceneGap = (gapMin: number) => useSceneSettings.setState({ gapMin });
  const contentWeight = useSceneSettings((s) => s.contentWeight);
  const setContentWeight = (weight: number) => useSceneSettings.setState({ contentWeight: weight });
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

export function registerScenes(): void {
  registerView({
    id: "scenes",
    label: "Scenes",
    hint: "moments inferred from time and content",
    component: () => <GalleryGrid useGroups={useSceneGroups} />,
    keywords: ["moments", "groups", "series", "burst"],
    zoomable: false,
    stacks: true,
    Knobs: SceneKnobs,
  });
  registerSceneCommands();
}
