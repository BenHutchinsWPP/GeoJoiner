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
  control: "#34495e",
};

/**
 * Qualitative palette for per-feature colouring. Ordered so neighbouring
 * entries stay distinguishable, since adjacent polygons often hash close
 * together.
 */
const FEATURE_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
  "#f032e6", "#bcf60c", "#fabebe", "#008080", "#9a6324", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#00a5ff",
];

/**
 * Stable colour for one polygon, derived from its own property value.
 *
 * Keyed off the value rather than the feature index so a point and the polygon
 * containing it resolve to the same colour without the map re-running any
 * point-in-polygon test — the join already recorded which polygon each point
 * landed in, and both sides hash the same string.
 *
 * FNV-1a: short, no dependency, and spreads single-character differences (the
 * "DISTRICT 1" / "DISTRICT 2" case) across the palette rather than clustering
 * them, which `charCodeAt` sums do not.
 */
export function autoColor(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return FEATURE_COLORS[(h >>> 0) % FEATURE_COLORS.length];
}

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

/** Only report progress every quarter MB — chunks arrive far faster than the UI needs. */
const PROGRESS_STEP = 256 * 1024;

/**
 * Fetch several URLs at once, reporting bytes downloaded vs. total expected.
 * All request headers are awaited before any body is read, so Content-Length
 * gives a real total up front. URLs that fail are simply absent from the
 * result — the caller decides which ones were required.
 */
export async function fetchAllWithProgress(
  urls: string[],
  onProgress: (loaded: number, total: number) => void,
): Promise<Map<string, ArrayBuffer>> {
  const settled = await Promise.allSettled(urls.map((u) => fetchWithRetry(u)));
  const ok = settled.flatMap((s, i) =>
    s.status === "fulfilled" ? [{ url: urls[i], res: s.value }] : [],
  );

  const total = ok.reduce(
    (n, { res }) => n + (Number(res.headers.get("content-length")) || 0),
    0,
  );
  let loaded = 0;
  let reported = 0;
  onProgress(0, total);

  const out = new Map<string, ArrayBuffer>();
  await Promise.all(
    ok.map(async ({ url, res }) => {
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (loaded - reported >= PROGRESS_STEP) {
          reported = loaded;
          onProgress(loaded, total);
        }
      }
      out.set(url, await new Blob(chunks).arrayBuffer());
    }),
  );

  onProgress(loaded, total);
  return out;
}

export function manifestToLayerConfig(entry: ManifestEntry): LayerConfig {
  const properties: PropertyOption[] = entry.properties?.length
    ? entry.properties
    : [{ key: entry.defaultPropertyKey, label: entry.defaultPropertyKey }];
  const propertyKey = entry.defaultPropertyKey || properties[0].key;
  const suggestion = entry.suggestion || entry.label.replace(/\s+/g, "_");
  return {
    id: entry.id,
    label: entry.label,
    sourceUrl: entry.sourceUrl,
    suggestion,
    source: "builtin",
    propertyKeys: [propertyKey],
    availableProperties: properties,
    labelKey: entry.labelKey,
    color: entry.color || BUILTIN_COLORS[entry.id] || "#888",
  };
}
