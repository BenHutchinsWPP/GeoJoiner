/**
 * KML → GeoJSON FeatureCollection parser
 *
 * Handles:
 *   - <Placemark> with <Polygon> and <MultiGeometry> (polygons only)
 *   - Outer + inner boundary rings (holes)
 *   - <name>, <description>, and <ExtendedData> properties
 *   - Namespace-agnostic (kml: prefix or default namespace)
 *   - Nested <Document>/<Folder> structure
 *
 * Coordinates: lon,lat[,alt] triples separated by whitespace (KML standard).
 */

import type { FeatureCollection, Feature, Polygon, MultiPolygon, Position } from "geojson";

export interface KmlParseResult {
  geojson: FeatureCollection;
  /** All property keys found across all features */
  propertyKeys: string[];
  /** Number of polygon/multipolygon features parsed */
  featureCount: number;
  /** Any warnings from parsing */
  warnings: string[];
}

/** Property keys the <name> and <description> elements land under. */
const NAME_KEY = "Name";
const DESC_KEY = "Description";

/**
 * Parse a KML string into a GeoJSON FeatureCollection (Polygon/MultiPolygon only).
 */
export function parseKml(kmlText: string): KmlParseResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Invalid XML: " + (parseError.textContent || "Unknown parse error"));
  }

  const warnings: string[] = [];
  const propertiesSet = new Set<string>([NAME_KEY, DESC_KEY]);
  const features: Feature<Polygon | MultiPolygon>[] = [];

  // Get all Placemarks — simple tag name match (cross-browser, crosses namespaces)
  // Use getElementsByTagName which ignores namespaces entirely
  const placemarks = doc.getElementsByTagName("Placemark");
  if (placemarks.length === 0) {
    throw new Error("No Placemark elements found in KML. At least one polygon Placemark is required.");
  }

  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const props = extractProperties(pm);

    // Collect property keys
    for (const key of Object.keys(props)) {
      propertiesSet.add(key);
    }

    // Find geometry
    const geomEl = findGeometryElement(pm);
    if (!geomEl) {
      warnings.push(`Placemark "${props[NAME_KEY] || i}" has no polygon geometry — skipping`);
      continue;
    }

    const geoType = geomEl.tagName.toLowerCase().replace(/^.*:/, "");
    let coordinates: Position[][][] | null = null;

    if (geoType === "polygon") {
      const rings = extractPolygon(geomEl);
      if (rings) coordinates = [rings];
    } else if (geoType === "multigeometry") {
      coordinates = extractMultiGeometry(geomEl, warnings);
    }

    if (!coordinates) {
      warnings.push(`Placemark "${props[NAME_KEY] || i}" — could not extract valid polygon coordinates`);
      continue;
    }

    const geoTypeName = geoType === "multigeometry" ? "MultiPolygon" : "Polygon";
    const geometry: Polygon | MultiPolygon =
      coordinates.length === 1 && geoType !== "multigeometry"
        ? { type: "Polygon", coordinates: coordinates[0] }
        : { type: "MultiPolygon", coordinates };

    features.push({
      type: "Feature",
      geometry,
      properties: props,
    });
  }

  if (features.length === 0) {
    throw new Error("No valid polygon features found in KML. Each Placemark needs a <Polygon>.");
  }

  return {
    geojson: { type: "FeatureCollection", features },
    propertyKeys: Array.from(propertiesSet),
    featureCount: features.length,
    warnings,
  };
}

// ── Property Extraction ───────────────────────────────────────────

function extractProperties(pm: Element): Record<string, string> {
  const props: Record<string, string> = {};

  // <name>
  const nameText = getChildText(pm, "name");
  if (nameText) props[NAME_KEY] = nameText.trim();

  // <description>
  const descText = getChildText(pm, "description");
  if (descText) props[DESC_KEY] = descText.trim();

  // <ExtendedData>
  const extData = findChildNS(pm, "*", "ExtendedData");
  if (extData) {
    // <Data name="key"><value>val</value></Data>
    const dataElements = extData.getElementsByTagName("Data");
    for (let i = 0; i < dataElements.length; i++) {
      const data = dataElements[i];
      const dataName = data.getAttribute("name");
      if (dataName) {
        const valueEl = findChildNS(data, "*", "value");
        const val = valueEl ? valueEl.textContent?.trim() || "" : data.textContent?.trim() || "";
        if (val) props[dataName] = val;
      }
    }

    // <SchemaData><SimpleData name="key">val</SimpleData></SchemaData>
    const schemaData = findChildNS(extData, "*", "SchemaData");
    if (schemaData) {
      const simpleDataElements = schemaData.getElementsByTagName("SimpleData");
      for (let i = 0; i < simpleDataElements.length; i++) {
        const sd = simpleDataElements[i];
        const sdName = sd.getAttribute("name");
        if (sdName) {
          const val = sd.textContent?.trim() || "";
          if (val) props[sdName] = val;
        }
      }
    }
  }

  return props;
}

// ── Geometry Extraction ──────────────────────────────────────────

function findGeometryElement(pm: Element): Element | null {
  // Look for direct child geometry elements: Polygon, MultiGeometry
  for (const tag of ["Polygon", "MultiGeometry"]) {
    const el = findChildNS(pm, "*", tag);
    if (el) return el;
  }
  return null;
}

/**
 * Extract a single Polygon from a <Polygon> element.
 * Returns coordinates: [outerRing, holeRing1, holeRing2, ...]
 */
function extractPolygon(polygonEl: Element): Position[][] | null {
  const outerBoundary = findChildNS(polygonEl, "*", "outerBoundaryIs");
  if (!outerBoundary) return null;

  const outerRing = findChildNS(outerBoundary, "*", "LinearRing");
  if (!outerRing) return null;

  const outerCoords = parseCoordinatesElement(outerRing);
  if (!outerCoords || outerCoords.length < 4) return null;

  const rings: Position[][] = [outerCoords];

  // Inner boundaries (holes)
  const innerBoundaries = polygonEl.getElementsByTagName("innerBoundaryIs");
  for (let i = 0; i < innerBoundaries.length; i++) {
    const innerRing = findChildNS(innerBoundaries[i], "*", "LinearRing");
    if (innerRing) {
      const innerCoords = parseCoordinatesElement(innerRing);
      if (innerCoords && innerCoords.length >= 4) {
        rings.push(innerCoords);
      }
    }
  }

  return rings;
}

/**
 * Extract polygons from a <MultiGeometry> element.
 * Returns an array of polygon coordinate arrays.
 */
function extractMultiGeometry(multiEl: Element, warnings: string[]): Position[][][] | null {
  const polygons = multiEl.getElementsByTagName("Polygon");
  if (polygons.length === 0) return null;

  const result: Position[][][] = [];
  for (let i = 0; i < polygons.length; i++) {
    const rings = extractPolygon(polygons[i]);
    if (rings) {
      result.push(rings);
    }
  }
  return result.length > 0 ? result : null;
}

/**
 * Parse a <coordinates> element text into an array of [lon, lat] positions.
 * KML format: "lon,lat[,alt] lon,lat[,alt] ..." separated by whitespace.
 * We drop altitude (third value) and close the ring if needed.
 */
function parseCoordinatesElement(linearRing: Element): Position[] | null {
  const coordsEl = findChildNS(linearRing, "*", "coordinates");
  if (!coordsEl || !coordsEl.textContent) return null;

  const raw = coordsEl.textContent.trim();
  const parts = raw.split(/\s+/);
  const coords: Position[] = [];

  for (const part of parts) {
    if (!part.trim()) continue;
    const vals = part.split(",");
    if (vals.length < 2) continue;

    const lon = parseFloat(vals[0].trim());
    const lat = parseFloat(vals[1].trim());

    if (isFinite(lon) && isFinite(lat)) {
      coords.push([lon, lat]);
    }
  }

  if (coords.length < 3) return null;

  // Ensure ring is closed (KML doesn't require it, GeoJSON does)
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([first[0], first[1]]);
  }

  return coords;
}

// ── XML Helpers ──────────────────────────────────────────────────

function getChildText(parent: Element, tagName: string): string | null {
  const child = findChildNS(parent, "*", tagName);
  return child?.textContent || null;
}

/**
 * Find the first direct child element matching namespace and local tag name.
 * Using "*" for namespace is namespace-agnostic.
 */
function findChildNS(parent: Element, ns: string, tagName: string): Element | null {
  // Use childNodes instead of children for cross-browser XML namespace support
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType !== 1) continue; // skip non-element nodes
    const el = child as Element;
    const localName = el.tagName.includes(":") ? el.tagName.split(":")[1] : el.tagName;
    if (localName.toLowerCase() === tagName.toLowerCase()) {
      return el;
    }
  }
  return null;
}