import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Map as LeafletMap } from "leaflet";
import type { FeatureCollection } from "geojson";
import type { LayerConfig } from "../geo/types";

interface Props {
  points: [number, number][];
  layers: { config: LayerConfig; geojson: FeatureCollection }[];
  height?: string;
}

const MAX_MARKERS = 5000;

export default function MapPanel({ points, layers, height = "500px" }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const geoLayersRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const layerControlRef = useRef<L.Control.Layers | null>(null);
  const markersRef = useRef<L.CircleMarker[]>([]);

  // Init map (once)
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current, {
      center: [39.8, -98.5],
      zoom: 4,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    mapInstance.current = map;
    layerControlRef.current = L.control.layers(undefined, undefined, {
      collapsed: false,
    }).addTo(map);

    return () => {
      map.remove();
      mapInstance.current = null;
      layerControlRef.current = null;
    };
  }, []);

  // GeoJSON boundary layers
  useEffect(() => {
    const map = mapInstance.current;
    const layerControl = layerControlRef.current;
    if (!map || !layerControl) return;

    for (const [, layer] of geoLayersRef.current) {
      layerControl.removeLayer(layer);
      map.removeLayer(layer);
    }
    geoLayersRef.current.clear();

    for (const { config, geojson } of layers) {
      const geoLayer = L.geoJSON(geojson as any, {
        style: {
          fillColor: config.color || "#3388ff",
          fillOpacity: 0.15,
          weight: 1,
          color: "#333",
        },
        onEachFeature: (feature, layer) => {
          layer.on({
            mouseover: (e) => {
              e.target.setStyle({ fillOpacity: 0.4, weight: 2 });
              const val = feature.properties?.[config.propertyKeys[0]];
              if (val) {
                e.target.bindTooltip(String(val), { sticky: true }).openTooltip(e.latlng);
              }
            },
            mouseout: (e) => {
              e.target.setStyle({ fillOpacity: 0.15, weight: 1 });
              e.target.unbindTooltip();
            },
          });
        },
      });

      geoLayer.addTo(map);
      geoLayersRef.current.set(config.id, geoLayer);
      layerControl.addOverlay(geoLayer, config.label);
    }
  }, [layers]);

  // Point markers (circle markers — simpler than raster overlay)
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    for (const m of markersRef.current) map.removeLayer(m);
    markersRef.current = [];

    if (points.length === 0) return;

    const step = points.length > MAX_MARKERS ? Math.ceil(points.length / MAX_MARKERS) : 1;
    const markers: L.CircleMarker[] = [];

    for (let i = 0; i < points.length; i += step) {
      const [lat, lng] = points[i];
      markers.push(
        L.circleMarker([lat, lng], {
          radius: 5,
          fillColor: "#ff4444",
          color: "#ffffff",
          weight: 1,
          opacity: 0.8,
          fillOpacity: 0.7,
        }).addTo(map),
      );
    }

    markersRef.current = markers;

    // Fit view
    const lats = points.map((p) => p[0]);
    const lngs = points.map((p) => p[1]);
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    );
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    return () => {
      for (const m of markers) map.removeLayer(m);
    };
  }, [points]);

  return (
    <div className="map-panel">
      <h2>Map</h2>
      <div ref={mapRef} style={{ height, width: "100%", borderRadius: "8px" }} />
    </div>
  );
}