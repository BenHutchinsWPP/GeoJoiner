/**
 * KMZ Parser — extracts KML text from a KMZ (ZIP) archive.
 *
 * KMZ is a standard ZIP archive containing one or more KML files.
 * The default KML file is typically "doc.kml".
 *
 * Uses jszip for ZIP decompression.
 */

import type { KmlParseResult } from "./kmlParser";
import { parseKml } from "./kmlParser";

/**
 * Extract KML from a KMZ archive and parse it to GeoJSON.
 *
 * @param arrayBuffer - The raw file bytes of the KMZ file
 * @returns KmlParseResult
 */
export async function parseKmz(arrayBuffer: ArrayBuffer): Promise<KmlParseResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Find the .kml file — prefer doc.kml (standard), else first .kml
  const kmlFileName = findKmlEntry(zip);
  if (!kmlFileName) {
    throw new Error("No .kml file found in KMZ archive.");
  }

  return parseKml(await zip.files[kmlFileName].async("text"));
}

/**
 * Find the KML entry inside a ZIP. Prefers "doc.kml" (the KML standard),
 * otherwise returns the first .kml file found.
 */
function findKmlEntry(zip: import("jszip")): string | null {
  const files = zip.files;
  const entries = Object.keys(files).filter((name) => name.endsWith(".kml"));

  if (entries.length === 0) return null;
  if (entries.includes("doc.kml")) return "doc.kml";

  // Return the first .kml entry (ignore directory structure for now)
  return entries.sort()[0];
}