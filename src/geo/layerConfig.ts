import type { LayerConfig, LayerOutput, ManifestEntry, PropertyOption } from "./types";

/** Slugify a string into a safe CSV column token. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Auto-derive the output column name from a layer's base name + selected
 * property. The default (first) property uses just the base name; any other
 * property appends its friendly label so columns stay self-describing.
 */
function deriveOutputColumn(
  base: string,
  properties: PropertyOption[],
  propertyKey: string,
): string {
  const idx = properties.findIndex((p) => p.key === propertyKey);
  if (idx <= 0) return slug(base);
  return slug(`${base}_${properties[idx].label}`);
}

/**
 * Derive one output column per selected property key, preserving the order in
 * which they appear in `properties` (not selection order) so columns stay
 * stable across re-selection.
 */
export function deriveOutputColumns(
  base: string,
  properties: PropertyOption[],
  propertyKeys: string[],
): LayerOutput[] {
  const selected = new Set(propertyKeys);
  return properties
    .filter((p) => selected.has(p.key))
    .map((p) => ({
      propertyKey: p.key,
      outputColumn: deriveOutputColumn(base, properties, p.key),
    }));
}

/** Retry a fetch up to `retries` times with exponential backoff */
async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts`);
}

export const BUILTIN_COLORS: Record<string, string> = {
  country: "#e74c3c",
  state: "#3498db",
  county: "#2ecc71",
  zcta: "#f39c12",
  ba: "#9b59b6",
  nerc: "#1abc9c",
  province: "#e67e22",
  retail: "#e84393",
};

const BASE = import.meta.env.BASE_URL || "/";
const DEFAULT_MANIFEST_URL = `${BASE}data/manifest.json`;

/**
 * Prefix a relative or hardcoded manifest path with the correct base URL.
 * Strips any known hardcoded base prefix (e.g. /GeoJoiner/) so it works
 * regardless of the deployment path.
 */
export function resolveAssetUrl(path: string | null | undefined): string {
  if (!path) return "";
  // Remove any hardcoded /GeoJoiner/ prefix so BASE_URL substitution works
  const cleaned = path.replace(/^\/[^/]+\//, "/");
  return cleaned.startsWith(BASE) ? cleaned : `${BASE}${cleaned.replace(/^\//, "")}`;
}

export async function loadManifest(
  url: string = DEFAULT_MANIFEST_URL,
): Promise<ManifestEntry[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to load manifest: ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

/**
 * Fetch a .gjbf binary layer — orders of magnitude faster than JSON.parse.
 */
export async function fetchBinaryLayer(url: string): Promise<ArrayBuffer> {
  const res = await fetchWithRetry(url);
  return res.arrayBuffer();
}

/**
 * Fetch a .grid spatial index file.
 */
export async function fetchGrid(url: string): Promise<ArrayBuffer> {
  const res = await fetchWithRetry(url);
  return res.arrayBuffer();
}

export function manifestToLayerConfig(
  entry: ManifestEntry,
  _selected: boolean,
): LayerConfig {
  const properties: PropertyOption[] = entry.properties?.length
    ? entry.properties
    : [{ key: entry.defaultPropertyKey, label: entry.defaultPropertyKey }];
  const propertyKey = entry.defaultPropertyKey || properties[0].key;
  const suggestion = entry.suggestion || entry.label.replace(/\s+/g, "_");
  return {
    id: entry.id,
    label: entry.label,
    suggestion,
    source: "builtin",
    url: entry.url,
    propertyKeys: [propertyKey],
    availableProperties: properties,
    color: entry.color || BUILTIN_COLORS[entry.id] || "#888",
  };
}
