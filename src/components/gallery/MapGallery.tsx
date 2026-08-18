import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { fileUrl, requestThumbnails } from "../../ipc";
import { gpsOf } from "../../state/derived";
import { useAppStore, useVisibleEntries } from "../../state/store";

/**
 * The gallery as a map: every geolocated visible entry becomes a thumbnail
 * marker. Filters and sort apply exactly as in the grid — the map is just
 * another rendering of the same query, restricted to entries with a GPS tag
 * (local EXIF, or source-provided for e.g. Wikimedia Commons).
 */
export function MapGallery() {
  const entries = useVisibleEntries();
  const meta = useAppStore((s) => s.meta);
  const thumbs = useAppStore((s) => s.thumbs);
  const epoch = useAppStore((s) => s.epoch);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  /** Epoch the map was last auto-fitted for — one fit per scope, then hands off. */
  const fittedEpochRef = useRef<number | null>(null);

  const located = useMemo(
    () =>
      entries.flatMap((entry, index) => {
        const gps = gpsOf(meta[entry.path]);
        return gps ? [{ entry, index, gps }] : [];
      }),
    [entries, meta],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, worldCopyJump: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.setView([30, 0], 2);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Markers need thumbnails even though the grid never scrolled to them.
  useEffect(() => {
    const { thumbs, thumbErrors } = useAppStore.getState();
    const wanted = located
      .map(({ entry }) => entry.path)
      .filter((path) => !(path in thumbs) && !(path in thumbErrors));
    if (wanted.length > 0) void requestThumbnails(wanted, epoch);
  }, [located, epoch]);

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;
    markers.clearLayers();
    for (const { entry, index, gps } of located) {
      const thumb = thumbs[entry.path];
      const icon = L.divIcon({
        className: "map-marker",
        html: thumb
          ? `<img src="${fileUrl(thumb)}" alt="" draggable="false" />`
          : `<span class="map-dot"></span>`,
        iconSize: thumb ? [48, 48] : [10, 10],
      });
      L.marker([gps.lat, gps.lon], { icon, title: entry.name })
        .addTo(markers)
        .on("click", () => useAppStore.getState().openViewer(index));
    }
    if (located.length > 0 && fittedEpochRef.current !== epoch) {
      fittedEpochRef.current = epoch;
      map.fitBounds(L.latLngBounds(located.map(({ gps }) => [gps.lat, gps.lon])), {
        padding: [48, 48],
        maxZoom: 10,
      });
    }
  }, [located, thumbs, epoch]);

  return (
    <div className="map-gallery">
      <div ref={containerRef} className="map-canvas" />
      {located.length === 0 ? (
        <p className="map-empty">No photographs here carry a location.</p>
      ) : (
        <span className="map-note">
          {located.length} of {entries.length} geolocated
        </span>
      )}
    </div>
  );
}
