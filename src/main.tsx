import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { GalleryGrid, noGroups } from "./components/gallery/GalleryGrid";
import { DarkroomGallery } from "./components/gallery/DarkroomGallery";
import { MosaicGallery } from "./components/gallery/MosaicGallery";
import { TimelineGallery } from "./components/gallery/TimelineGallery";
import { DarkroomKnobs, GridKnobs, MosaicKnobs, TimelineKnobs } from "./components/gallery/viewKnobs";
import { registerBuiltinCommands, registerSortCommands } from "./commands/builtin";
import { registerCopyCommands } from "./commands/copy";
import { registerDevelopCommands } from "./commands/develop";
import { registerMap } from "./features/map";
import { registerScenes } from "./features/scenes";
import { registerSourceCommands } from "./commands/sources";
import { registerTrashCommands } from "./commands/trash";
import { DevelopLoupe } from "./components/develop/DevelopLoupe";
import { DevelopPanel } from "./components/develop/DevelopPanel";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { FolderIcon, SimilarityIcon } from "./components/shell/icons";
import { ColorsPanel, HistogramPanel, ShotPanel } from "./components/shell/InfoPanel";
import { SimilarityPanel } from "./components/shell/SimilarityPanel";
import { makeSourcePanel } from "./components/shell/SourcePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerCommand } from "./registry/commands";
import { allPanels, always, registerPanel } from "./registry/panels";
import { allViews, registerView } from "./registry/views";
import { allSources, registerSource } from "./registry/sources";
import { registerBuiltinFacts } from "./facts/builtin";
import { registerBuiltinFilterFields } from "./filters/builtin";
import { registerLabels } from "./features/labels";
import { registerThumbCrops } from "./state/thumbCrops";
import { useDevelopStore } from "./state/develop";
import { useAppStore, visibleOf } from "./state/store";
import { registerPeople } from "./features/people";
import { registerSimilarity } from "./features/similarity";
import { startEmbeddings } from "./state/embeddings";
import { commonsSource } from "./features/sources/commons";
import { redditSource } from "./features/sources/reddit";
import { registerBuiltinSorts } from "./sorts/builtin";

registerView({
  id: "grid",
  label: "Grid",
  hint: "regular thumbnail rows",
  component: () => <GalleryGrid useGroups={noGroups} />,
  keywords: ["thumbnails", "cells"],
  zoomable: false,
  stacks: false,
  Knobs: GridKnobs,
});
registerView({
  id: "mosaic",
  label: "Mosaic",
  hint: "edge-to-edge photographs",
  component: MosaicGallery,
  keywords: ["packed", "wall", "justified"],
  zoomable: false,
  stacks: false,
  Knobs: MosaicKnobs,
});
registerScenes();
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
registerMap();
registerView({
  id: "darkroom",
  label: "Darkroom",
  hint: "main image + filmstrip; loupe, culling, editing",
  component: DarkroomGallery,
  keywords: ["develop", "edit", "filmstrip", "lightroom", "carousel", "loupe"],
  zoomable: true,
  stacks: true,
  Knobs: DarkroomKnobs,
});

registerBuiltinCommands();
registerBuiltinSorts();
registerBuiltinFilterFields();
registerBuiltinFacts();
// Sources must register before registerSortCommands below, so their sorts get commands too.
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
startEmbeddings();
registerSimilarity();
registerLabels();
registerThumbCrops();
registerPeople();
registerDevelopCommands();
// Menu rows follow registration order; Trash registers last to sit at the bottom.
registerCopyCommands();
registerTrashCommands();
registerSortCommands();
const left = { side: "left" as const, fill: false, when: always };
registerPanel({ ...left, id: "folders", title: "Folders", component: FolderTreePanel, icon: <FolderIcon />, order: 10 });
for (const source of allSources()) {
  registerPanel({
    ...left,
    id: `source-${source.id}`,
    title: source.sidebarTitle,
    component: makeSourcePanel(source),
    icon: source.icon,
    order: 20,
  });
}
registerPanel({ ...left, id: "similarity", title: "Similarity", component: SimilarityPanel, icon: <SimilarityIcon />, order: 30 });
// Default positions are the order numbers; features register theirs (people 40 left, labels 50 right).
const right = { side: "right" as const, icon: null, fill: false };
const selected = () => useAppStore.getState().selectedIndex !== null;
const inSession = () => useDevelopStore.getState().session !== null;
registerPanel({ ...right, id: "shot", title: "Shot", component: ShotPanel, order: 10, when: selected });
registerPanel({ ...right, id: "loupe", title: "Loupe", component: DevelopLoupe, order: 20, when: inSession });
registerPanel({ ...right, id: "histogram", title: "Histogram", component: HistogramPanel, order: 30, when: inSession });
registerPanel({ ...right, id: "develop", title: "Develop", component: DevelopPanel, order: 40, when: inSession });
registerPanel({ ...right, id: "colors", title: "Colors", component: ColorsPanel, order: 60, when: selected });
registerPanel({
  ...right,
  id: "stats",
  title: "Statistics",
  component: StatsPanel,
  order: 70,
  fill: true,
  when: () => {
    const state = useAppStore.getState();
    return state.viewMode === "gallery"
      && state.galleryLayout !== "darkroom"
      && visibleOf(state, state.query).length > 1;
  },
});
for (const panel of allPanels("left")) {
  registerCommand({
    id: `view.${panel.id}`,
    title: `Show ${panel.title}`,
    input: null,
    when: () => true,
    keywords: ["view", "panel", "sidebar"],
    menus: [],
    run: ({ store }) => store.getState().setActivePanel(panel.id),
  });
}

// Assert registration during startup: commands and the shell both depend on this being non-empty.
if (allViews().length === 0) throw new Error("no gallery views registered");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
