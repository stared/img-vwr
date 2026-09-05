import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { DarkroomGallery } from "./components/gallery/DarkroomGallery";
import { MapGallery } from "./components/gallery/MapGallery";
import { MosaicGallery } from "./components/gallery/MosaicGallery";
import { TimelineGallery } from "./components/gallery/TimelineGallery";
import { registerBuiltinCommands, registerSortCommands } from "./commands/builtin";
import { registerCopyCommands } from "./commands/copy";
import { registerDevelopCommands } from "./commands/develop";
import { registerSceneCommands } from "./commands/scenes";
import { registerSourceCommands } from "./commands/sources";
import { registerTrashCommands } from "./commands/trash";
import { DevelopLoupe } from "./components/develop/DevelopLoupe";
import { DevelopPanel } from "./components/develop/DevelopPanel";
import { FolderTreePanel } from "./components/shell/FolderTreePanel";
import { FolderIcon, SimilarityIcon, SOURCE_ICONS } from "./components/shell/icons";
import { ColorsPanel, HistogramPanel, LabelsPanel, ShotPanel } from "./components/shell/InfoPanel";
import { SimilarityPanel } from "./components/shell/SimilarityPanel";
import { makeSourcePanel } from "./components/shell/SourcePanel";
import { StatsPanel } from "./components/shell/StatsPanel";
import { registerCommand } from "./registry/commands";
import { allPanels, registerPanel } from "./registry/panels";
import { allViews, registerView } from "./registry/views";
import { allSources, registerSource } from "./registry/sources";
import { registerBuiltinFacts } from "./facts/builtin";
import { registerBuiltinFilterFields } from "./filters/builtin";
import { registerLabels } from "./labels";
import { registerThumbCrops } from "./state/thumbCrops";
import { useDevelopStore } from "./state/develop";
import { useAppStore, visibleOf } from "./state/store";
import { PeoplePanel, registerPeople } from "./people";
import { registerSimilarity } from "./similarity";
import { commonsSource } from "./sources/commons";
import { redditSource } from "./sources/reddit";
import { registerBuiltinSorts } from "./sorts/builtin";

registerView({
  id: "grid",
  label: "Grid",
  hint: "regular thumbnail rows",
  component: () => <GalleryGrid grouped={false} />,
  keywords: ["thumbnails", "cells"],
  zoomable: false,
});
registerView({
  id: "mosaic",
  label: "Mosaic",
  hint: "edge-to-edge photographs",
  component: MosaicGallery,
  keywords: ["packed", "wall", "justified"],
  zoomable: false,
});
registerView({
  id: "scenes",
  label: "Scenes",
  hint: "moments inferred from time and content",
  component: () => <GalleryGrid grouped />,
  keywords: ["moments", "groups", "series", "burst"],
  zoomable: false,
});
registerView({
  id: "timeline",
  label: "Timeline",
  hint: "photographs positioned by capture time",
  component: TimelineGallery,
  keywords: ["date", "taken", "time", "chronological"],
  zoomable: false,
});
registerView({
  id: "map",
  label: "Map",
  hint: "photographs with GPS locations",
  component: MapGallery,
  keywords: ["geo", "gps", "location"],
  zoomable: false,
});
registerView({
  id: "darkroom",
  label: "Darkroom",
  hint: "main image + filmstrip; loupe, culling, editing",
  component: DarkroomGallery,
  keywords: ["develop", "edit", "filmstrip", "lightroom", "carousel", "loupe"],
  zoomable: true,
});

registerBuiltinCommands();
registerBuiltinSorts();
registerBuiltinFilterFields();
registerBuiltinFacts();
// Sources must register before registerSortCommands below, so their sorts get commands too.
registerSource(redditSource);
registerSource(commonsSource);
registerSourceCommands();
registerSimilarity();
registerLabels();
registerThumbCrops();
registerPeople();
registerDevelopCommands();
registerSceneCommands();
// Menu rows follow registration order; Trash registers last to sit at the bottom.
registerCopyCommands();
registerTrashCommands();
registerSortCommands();
registerPanel({ id: "folders", title: "Folders", component: FolderTreePanel, icon: <FolderIcon /> });
for (const source of allSources()) {
  registerPanel({
    id: `source-${source.id}`,
    title: source.sidebarTitle,
    component: makeSourcePanel(source),
    icon: SOURCE_ICONS[source.id] ?? source.glyph,
  });
}
registerPanel({
  id: "similarity",
  title: "Similarity",
  component: SimilarityPanel,
  icon: <SimilarityIcon />,
});
registerPanel({ id: "people", title: "People", component: PeoplePanel, icon: "☺" });
// Right-panel registration order is the default section order.
const selected = () => useAppStore.getState().selectedIndex !== null;
const inSession = () => useDevelopStore.getState().session !== null;
registerPanel({ id: "shot", title: "Shot", component: ShotPanel, side: "right", when: selected });
registerPanel({ id: "loupe", title: "Loupe", component: DevelopLoupe, side: "right", when: inSession });
registerPanel({
  id: "histogram",
  title: "Histogram",
  component: HistogramPanel,
  side: "right",
  when: inSession,
});
registerPanel({
  id: "develop",
  title: "Develop",
  component: DevelopPanel,
  side: "right",
  when: inSession,
});
registerPanel({ id: "labels", title: "Labels", component: LabelsPanel, side: "right", when: selected });
registerPanel({ id: "colors", title: "Colors", component: ColorsPanel, side: "right", when: selected });
registerPanel({
  id: "stats",
  title: "Statistics",
  component: StatsPanel,
  side: "right",
  fill: true,
  when: () => {
    const state = useAppStore.getState();
    return state.viewMode === "gallery"
      && state.galleryLayout !== "darkroom"
      && visibleOf(state, state.query).length > 1;
  },
});
for (const panel of allPanels()) {
  registerCommand({
    id: `view.${panel.id}`,
    title: `Show ${panel.title}`,
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
