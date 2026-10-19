import { registerView } from "../../registry/views";
import "./map.css";
import { MapGallery } from "./MapGallery";

/** Photographs placed by their GPS tags, on OpenStreetMap tiles (Leaflet). */
export function registerMap(): void {
  registerView({
    id: "map",
    label: "Map",
    hint: "photographs with GPS locations",
    component: MapGallery,
    keywords: ["geo", "gps", "location"],
    zoomable: false,
    stacks: false,
    Knobs: null,
  });
}
