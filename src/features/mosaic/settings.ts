import { settingsStore } from "../../state/settingsStore";

export const useMosaicSettings = settingsStore(
  "imgvwr.mosaic.v1",
  {
    /** How tall rows aim to be, px. */
    rowPx: 180,
    /** "order": as sorted, rows vary a little in scale; "packed": one scale, reordered locally to fit. */
    packing: "order" as "order" | "packed",
  },
  { packing: ["order", "packed"] },
  { rowPx: "mosaicRowPx", packing: "mosaicPacking" },
);
