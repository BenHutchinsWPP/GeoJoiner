import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Map as LeafletMap } from "leaflet";
import type { Feature, FeatureCollection } from "geojson";
import type { LayerConfig, MapPoint } from "../geo/types";
import { autoColor, deriveOutputColumns } from "../geo/layerConfig";

interface Props {
  points: MapPoint[];
  layers: { config: LayerConfig; getGeoJson: () => FeatureCollection }[];
  height?: string;
}

/** Rows shown in a point's popup before it is truncated. */
const MAX_POPUP_ROWS = 12;

/** Permanent polygon labels drawn at once. Each is a DOM node that Leaflet
 *  repositions on every pan and zoom, so this is a frame-rate budget, not a
 *  legibility one — a ZCTA-sized layer has 33k features and labelling them all
 *  locks the map up. Largest-first within the viewport keeps the ones a reader
 *  can actually place. */
const MAX_LABELS = 60;

/** The property whose value drives a layer's colouring — the first one the
 *  user chose to output, which is also what the polygon tooltip shows. */
const colorKey = (config: LayerConfig) =>
  config.propertyKeys[0] ?? config.availableProperties[0]?.key ?? "";

/** What to draw on the polygon: the layer's short identifier when it has one
 *  ("WA", "RFC"), else the same full name the hover tooltip shows. Short text
 *  also clears the fit test far more often, so more polygons end up labelled. */
const labelKey = (config: LayerConfig) => config.labelKey ?? colorKey(config);

/**
 * The polygon value a point matched for `config`.
 *
 * Under the "join" match mode a point inside overlapping polygons carries every
 * match separated by "; ", in feature order. The first segment is the same
 * polygon a first-match join would have returned, so colouring by it keeps the
 * point consistent with the polygon drawn beneath it.
 */
function matchedValue(point: MapPoint, config: LayerConfig): string {
  const key = colorKey(config);
  const col = deriveOutputColumns(config.suggestion, config.availableProperties, config.propertyKeys)
    .find((o) => o.propertyKey === key);
  // No column when that property is not among the selected outputs — the row
  // carries nothing to colour by, and the point falls back to neutral.
  if (!col) return "";
  return (point.row[col.outputColumn] ?? "").split("; ")[0].trim();
}

/** The shared popup table. Rows are [label, value]; empties are dropped.
 *  Built as DOM rather than an HTML string: textContent escapes by
 *  construction, so arbitrary CSV values need no manual escaping. */
function popupTable(pairs: [string, string][]): HTMLTableElement {
  const filled = pairs.filter(([, v]) => v !== "" && v != null);
  const table = document.createElement("table");
  table.className = "point-popup";
  for (const [k, v] of filled.slice(0, MAX_POPUP_ROWS)) {
    const tr = table.insertRow();
    const th = document.createElement("th");
    th.textContent = k;
    tr.append(th);
    tr.insertCell().textContent = String(v);
  }
  const hidden = filled.length - MAX_POPUP_ROWS;
  if (hidden > 0) table.createTFoot().insertRow().insertCell().textContent = `+${hidden} more`;
  return table;
}

/**
 * Popup for one polygon: every property the layer exposes, under the friendly
 * labels from the manifest rather than the raw column keys.
 */
function polygonPopupHtml(feature: Feature, config: LayerConfig): HTMLTableElement {
  const props = feature.properties ?? {};
  const named = new Set(config.availableProperties.map((p) => p.key));
  return popupTable([
    ...config.availableProperties.map(
      (p) => [p.label, String(props[p.key] ?? "")] as [string, string],
    ),
    // Anything stored in the layer but not described in the manifest.
    ...Object.keys(props)
      .filter((k) => !named.has(k))
      .map((k) => [k, String(props[k] ?? "")] as [string, string]),
  ]);
}

/** Popup for one point: joined layer columns first, then its own data. */
function popupHtml(point: MapPoint, layers: Props["layers"]): HTMLTableElement {
  const joined = new Set<string>();
  for (const { config } of layers) {
    for (const o of deriveOutputColumns(config.suggestion, config.availableProperties, config.propertyKeys)) {
      joined.add(o.outputColumn);
    }
  }
  const keys = Object.keys(point.row);
  // Joined columns lead — they are what the user came here to check.
  const ordered = [...keys.filter((k) => joined.has(k)), ...keys.filter((k) => !joined.has(k))];
  return popupTable(ordered.map((k) => [k, String(point.row[k] ?? "")] as [string, string]));
}

/** Must match .polygon-label in index.css — the fit test measures this font. */
const LABEL_FONT = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Scratch 2D context, reused purely for text measurement. */
let measureCtx: CanvasRenderingContext2D | undefined;
function textWidth(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d")!;
    measureCtx.font = LABEL_FONT;
  }
  return measureCtx.measureText(text).width;
}

/**
 * Label the largest features currently in view, and drop the rest.
 *
 * Leaflet keeps a permanent tooltip glued to its polygon through pan and zoom
 * on its own, so this only decides which features deserve one right now.
 */
function updateLabels(map: LeafletMap, geoLayer: L.GeoJSON, config: LayerConfig) {
  if (!map.hasLayer(geoLayer)) return;
  const view = map.getBounds();
  const inView: [number, L.Layer][] = [];

  geoLayer.eachLayer((l) => {
    const withBounds = l as L.Layer & { getBounds?: () => L.LatLngBounds };
    const b = withBounds.getBounds?.();
    if (!b || !view.intersects(b)) {
      if (l.getTooltip()?.options.permanent) l.unbindTooltip();
      return;
    }
    // Rough on-screen size, used only to rank labels against each other.
    inView.push([(b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()), l]);
  });

  inView.sort((a, b) => b[0] - a[0]);
  inView.forEach(([, l], i) => {
    const existing = l.getTooltip();
    if (i < MAX_LABELS) {
      if (existing) return;
      const text = (l as L.Layer & { feature?: Feature }).feature?.properties?.[labelKey(config)];
      if (!text) return;

      // Only label a polygon the text actually fits inside. A tooltip is a DOM
      // node at a fixed screen size and cannot be clipped to the shape, so
      // "District of Columbia" would otherwise sprawl across its neighbours.
      // Skipped labels are not lost — hovering still shows the name.
      const b = (l as L.Layer & { getBounds: () => L.LatLngBounds }).getBounds();
      const nw = map.latLngToContainerPoint(b.getNorthWest());
      const se = map.latLngToContainerPoint(b.getSouthEast());
      const wpx = Math.abs(se.x - nw.x);
      const hpx = Math.abs(se.y - nw.y);
      if (textWidth(String(text)) > wpx * 0.9 || hpx < 14) return;

      l.bindTooltip(String(text), {
        permanent: true,
        direction: "center",
        className: "polygon-label",
        // Non-interactive: a label sitting over a point must not swallow the
        // click that opens that point's popup.
        interactive: false,
      });
    } else if (existing?.options.permanent) {
      l.unbindTooltip();
    }
  });
}

export default function MapPanel({ points, layers, height = "500px" }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<LeafletMap | null>(null);
  const geoLayersRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const layerControlRef = useRef<L.Control.Layers | null>(null);
  const markersRef = useRef<L.CircleMarker[]>([]);
  /** Layer id whose colours the points currently follow — the topmost visible
   *  boundary layer. Kept in a ref so the overlay handlers can recolour without
   *  re-running the marker-building effect. */
  const colorLayerRef = useRef<string | null>(null);

  // Init map (once)
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current, {
      center: [39.8, -98.5],
      zoom: 4,
      zoomControl: true,
      // Every point is plotted, and one <path> element per row makes the DOM
      // unusable well before the data does.
      preferCanvas: true,
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

    const featureColor = (config: LayerConfig, feature?: Feature) => {
      const v = feature?.properties?.[colorKey(config)];
      return v ? autoColor(String(v)) : config.color || "#3388ff";
    };

    // Building a boundary layer costs seconds once the data is tens of MB, so
    // each one starts empty and is filled the first time it's switched on.
    // Only the first layer is on by default.
    layers.forEach(({ config, getGeoJson }, i) => {
      const geoLayer = L.geoJSON(undefined, {
        // Per feature rather than per layer, so neighbouring polygons are
        // actually distinguishable and each point can match the one under it.
        style: (feature) => ({
          fillColor: featureColor(config, feature),
          fillOpacity: 0.35,
          weight: 1,
          color: "#333",
        }),
        onEachFeature: (feature, layer) => {
          layer.on({
            mouseover: (e) => {
              e.target.setStyle({ fillOpacity: 0.6, weight: 2 });
              // Already carrying a permanent label — leave it be.
              if (e.target.getTooltip()) return;
              const val = feature.properties?.[colorKey(config)];
              if (val) {
                e.target.bindTooltip(String(val), { sticky: true }).openTooltip(e.latlng);
              }
            },
            mouseout: (e) => {
              e.target.setStyle({ fillOpacity: 0.35, weight: 1 });
              if (!e.target.getTooltip()?.options.permanent) e.target.unbindTooltip();
            },
            click: (e) => {
              // Bound on first click, like the point popups, so a 33k-feature
              // layer does not build 33k popups nobody opens.
              if (!e.target.getPopup()) {
                e.target.bindPopup(polygonPopupHtml(feature, config), {
                  className: "point-popup-wrap",
                  maxWidth: 420,
                  minWidth: 140,
                });
              }
              e.target.openPopup(e.latlng);
            },
          });
        },
      });

      geoLayer.once("add", () => {
        geoLayer.addData(getGeoJson() as any);
        updateLabels(map, geoLayer, config);
      });
      geoLayer.on("add", () => updateLabels(map, geoLayer, config));

      geoLayersRef.current.set(config.id, geoLayer);
      layerControl.addOverlay(geoLayer, config.label);
      if (i === 0) geoLayer.addTo(map);
    });

    colorLayerRef.current = layers[0]?.config.id ?? null;

    // Which features are on screen — and so which deserve a label — changes on
    // every pan and zoom.
    const relabel = () => {
      for (const { config } of layers) {
        const gl = geoLayersRef.current.get(config.id);
        if (gl) updateLabels(map, gl, config);
      }
    };
    map.on("moveend zoomend", relabel);
    return () => {
      map.off("moveend zoomend", relabel);
    };
  }, [layers]);

  // Point markers
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    for (const m of markersRef.current) map.removeLayer(m);
    markersRef.current = [];

    if (points.length === 0) return;

    /**
     * Keep the points drawn over the polygons.
     *
     * Both share one canvas renderer, where draw order decides both what is on
     * top and which layer wins a click (Leaflet keeps the last hit in draw
     * order). Points cannot live in their own pane: a canvas fills its pane, so
     * it becomes the topmost DOM node everywhere and swallows every event meant
     * for the polygons underneath. Sending the boundary layers back is also far
     * cheaper than bringing every point forward — a boundary layer has hundreds
     * of features where a CSV has hundreds of thousands of rows.
     */
    const raisePoints = () => {
      for (const { config } of layers) {
        const gl = geoLayersRef.current.get(config.id);
        if (gl && map.hasLayer(gl)) gl.bringToBack();
      }
    };

    /** Colour every point by the currently visible boundary layer. */
    const recolor = () => {
      const config = layers.find((l) => l.config.id === colorLayerRef.current)?.config;
      markersRef.current.forEach((m, idx) => {
        const v = config ? matchedValue(points[idx], config) : "";
        m.setStyle({ fillColor: v ? autoColor(v) : "#ff4444" });
      });
    };

    const config = layers.find((l) => l.config.id === colorLayerRef.current)?.config;

    // ponytail: one CircleMarker per row, canvas-rendered. Fine into the low
    // hundreds of thousands; past that switch to a single L.GridLayer drawing
    // points per tile, or bin them server-side before they reach the map.
    const markers = points.map((p) => {
      const v = config ? matchedValue(p, config) : "";
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: 5,
        fillColor: v ? autoColor(v) : "#ff4444",
        color: "#ffffff",
        weight: 1,
        opacity: 0.8,
        fillOpacity: 0.85,
      });
      // Bound on first click rather than up front: building one popup per row
      // costs more than the markers themselves on a large CSV.
      marker.on("click", () => {
        if (!marker.getPopup()) {
          marker.bindPopup(popupHtml(p, layers), {
            className: "point-popup-wrap",
            maxWidth: 420,
            minWidth: 140,
            closeButton: true,
          });
        }
        marker.openPopup();
      });
      return marker.addTo(map);
    });

    markersRef.current = markers;
    raisePoints();

    // Points follow whichever boundary layer is on top, so switching overlays
    // recolours them to match what is actually drawn underneath.
    const onOverlayAdd = (e: L.LayersControlEvent) => {
      const hit = layers.find((l) => geoLayersRef.current.get(l.config.id) === e.layer);
      if (hit) {
        colorLayerRef.current = hit.config.id;
        recolor();
      }
      // A newly added layer draws last, i.e. over the points, until sent back.
      raisePoints();
    };
    const onOverlayRemove = (e: L.LayersControlEvent) => {
      const hit = layers.find((l) => geoLayersRef.current.get(l.config.id) === e.layer);
      if (!hit || colorLayerRef.current !== hit.config.id) return;
      const stillOn = layers.find((l) => {
        const gl = geoLayersRef.current.get(l.config.id);
        return gl && map.hasLayer(gl);
      });
      colorLayerRef.current = stillOn?.config.id ?? null;
      recolor();
    };
    map.on("overlayadd", onOverlayAdd);
    map.on("overlayremove", onOverlayRemove);

    // Fit view
    const bounds = L.latLngBounds(
      points.map((p) => [p.lat, p.lon] as [number, number]),
    );
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    return () => {
      map.off("overlayadd", onOverlayAdd);
      map.off("overlayremove", onOverlayRemove);
      for (const m of markers) map.removeLayer(m);
    };
  }, [points, layers]);

  return (
    <div className="map-panel">
      <h2>Map</h2>
      <div ref={mapRef} style={{ height, width: "100%", borderRadius: "8px" }} />
    </div>
  );
}
