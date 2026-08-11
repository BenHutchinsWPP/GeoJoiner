/**
 * .gjbf binary format — encode / decode + fast point-in-polygon
 *
 * v2 adds per-ring bounding boxes for early rejection in pointInFeature.
 * v3 stores MULTIPLE named property columns (so the user can choose which
 *    property to output) instead of a single value per feature.
 *
 * Format (all little-endian):
 *   Header:       magic(4), version(4), numFeatures(4)
 *   Metadata:     numPolyGroups(4), numRings(4)
 *                 v1/v2: propKeyLen(4), propKeyStr(N)            — one column
 *                 v3:    numProps(4), then per prop: keyLen(4)+keyStr(N)
 *   Bboxes:       Float64Array(numFeatures * 4)
 *   PropValues:   v1/v2: strLen(4)+strBytes(N) per feature
 *                 v3:    per prop, per feature: strLen(4)+strBytes(N)  (column-major)
 *   PolyGroupStart: Uint32Array(numPolyGroups+1)
 *   RingGroupStart: Uint32Array(numRings+1)
 *   RingToFeature:  Uint32Array(numRings)
 *   Coord data:   numCoords(4) + Float64Array(numCoords*2) per ring
 *   Ring bboxes:  Float64Array(numRings * 4)  [v2+ only — minLon,minLat,maxLon,maxLat per ring]
 */

import type { FeatureCollection, Feature, Polygon, MultiPolygon } from "geojson";

export interface GjbfData {
  numFeatures: number;
  numPolyGroups: number;
  numRings: number;
  /** Ordered property column keys (first = default). */
  propKeys: string[];
  /** Property key → per-feature values. Keyed by `propKeys`. */
  propColumns: Record<string, string[]>;
  /** Default column key (first of `propKeys`), or null if none. */
  propKey: string | null;
  /** Values of the default column — convenience alias for `propColumns[propKey]`. */
  propValues: string[];
  bboxes: Float64Array;
  polyGroupStart: Uint32Array;
  ringGroupStart: Uint32Array;
  ringToFeature: Uint32Array;
  coordArrays: Float64Array[];
  /** Per-ring bounding boxes [minLon,minLat,maxLon,maxLat]. Length = numRings * 4. May be undefined for v1 data. */
  ringBboxes?: Float64Array;
  /** Grid refinement threshold for uploaded layers. Default 20. */
  refineThreshold: number;
  /** Grid sub-divisions per dense cell. Default 5. */
  subDivisions: number;
}

const MAGIC = 0x4642_4a47;
const VERSION = 3;

// ── Decode (runtime) ────────────────────────────────────────────────

export function decodeGjbf(buffer: ArrayBuffer): GjbfData {
  const dec = new TextDecoder();
  let off = 0;
  const r32 = () => { const v = new DataView(buffer, off, 4).getUint32(0, true); off += 4; return v; };
  const rstr = () => { const sl = r32(); const s = sl > 0 ? dec.decode(new Uint8Array(buffer, off, sl)) : ""; off += sl; return s; };

  const magic = r32();
  if (magic !== MAGIC) throw new Error(`Bad magic: 0x${magic.toString(16)}`);
  const version = r32();
  if (version < 1 || version > VERSION) throw new Error(`Bad version: ${version}`);
  const numFeatures = r32();
  const numPolyGroups = r32();
  const numRings = r32();

  // Property column keys
  const propKeys: string[] = [];
  if (version >= 3) {
    const numProps = r32();
    for (let p = 0; p < numProps; p++) propKeys.push(rstr());
  } else {
    const pkLen = r32();
    propKeys.push(pkLen > 0 ? dec.decode(new Uint8Array(buffer, off, pkLen)) : "");
    off += pkLen;
  }

  // Use buffer.slice() everywhere for typed arrays — avoids "start offset should be a multiple of 8"
  const bboxes = new Float64Array(buffer.slice(off, off + numFeatures * 4 * 8));
  off += bboxes.byteLength;

  // Property values: v3 is column-major (each column = numFeatures strings)
  const propColumns: Record<string, string[]> = {};
  for (const key of propKeys) {
    const col: string[] = new Array(numFeatures);
    for (let i = 0; i < numFeatures; i++) col[i] = rstr();
    propColumns[key] = col;
  }

  const polyGroupStart = new Uint32Array(buffer.slice(off, off + (numFeatures + 1) * 4)); off += polyGroupStart.byteLength;
  const ringGroupStart = new Uint32Array(buffer.slice(off, off + (numPolyGroups + 1) * 4)); off += ringGroupStart.byteLength;
  const ringToFeature = new Uint32Array(buffer.slice(off, off + numRings * 4)); off += ringToFeature.byteLength;

  const coordArrays: Float64Array[] = [];
  for (let i = 0; i < numRings; i++) {
    const nc = r32();
    const bytes = nc * 2 * 8;
    const slice = buffer.slice(off, off + bytes);
    coordArrays.push(new Float64Array(slice));
    off += bytes;
  }

  // v2+: read per-ring bounding boxes
  let ringBboxes: Float64Array | undefined;
  if (version >= 2 && off < buffer.byteLength) {
    ringBboxes = new Float64Array(buffer.slice(off, off + numRings * 4 * 8));
  }

  const propKey = propKeys.length ? propKeys[0] : null;
  const propValues = propKey ? propColumns[propKey] : [];

  return { numFeatures, numPolyGroups, numRings, propKeys, propColumns, propKey, propValues,
           bboxes, polyGroupStart, ringGroupStart, ringToFeature, coordArrays,
           ringBboxes, refineThreshold: 20, subDivisions: 5 };
}

/**
 * Reconstruct a GeoJSON FeatureCollection from decoded .gjbf — for map display,
 * so we never have to fetch the (much larger) raw .geojson source at runtime.
 * Mirrors the feature→polyGroup→ring walk used by `pointInFeature`.
 */
export function gjbfToFeatureCollection(data: GjbfData): FeatureCollection<Polygon | MultiPolygon> {
  const features: Feature<Polygon | MultiPolygon>[] = [];
  for (let fi = 0; fi < data.numFeatures; fi++) {
    const polys: number[][][][] = [];
    for (let pg = data.polyGroupStart[fi]; pg < data.polyGroupStart[fi + 1]; pg++) {
      const rings: number[][][] = [];
      for (let r = data.ringGroupStart[pg]; r < data.ringGroupStart[pg + 1]; r++) {
        const ca = data.coordArrays[r];
        const ring: number[][] = new Array(ca.length / 2);
        for (let k = 0, j = 0; k < ca.length; k += 2, j++) ring[j] = [ca[k], ca[k + 1]];
        rings.push(ring);
      }
      polys.push(rings);
    }
    const geometry: Polygon | MultiPolygon = polys.length === 1
      ? { type: "Polygon", coordinates: polys[0] }
      : { type: "MultiPolygon", coordinates: polys };
    const properties: Record<string, string> = {};
    for (const key of data.propKeys) properties[key] = data.propColumns[key][fi];
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

// ── Encode (on-the-fly for uploaded GeoJSON) ────────────────────────

export function geoJsonToGjbfBuffer(geojson: FeatureCollection): ArrayBuffer {
  const features = geojson.features.filter((f): f is Feature<Polygon | MultiPolygon> =>
    !!f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));

  // Collect the union of property keys across all features (first-seen order).
  const propKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const f of features) {
    if (!f.properties) continue;
    for (const k of Object.keys(f.properties)) {
      if (!seenKeys.has(k)) { seenKeys.add(k); propKeys.push(k); }
    }
  }

  const bboxes: number[] = [];
  // Column-major property values: propColumns[p][fi]
  const propColumns: string[][] = propKeys.map(() => []);
  const coordArrays: Float64Array[] = [];
  const ringToFeature: number[] = [];
  const polyGroupStart: number[] = [];
  const ringGroupStart: number[] = [];
  const ringBboxes: number[] = []; // [minLon, minLat, maxLon, maxLat] per ring
  let polyGroupCount = 0;

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const bb = computeBbox(feat.geometry!.coordinates);
    bboxes.push(bb[0], bb[1], bb[2], bb[3]);
    for (let p = 0; p < propKeys.length; p++) {
      propColumns[p].push(String(feat.properties?.[propKeys[p]] ?? ""));
    }
    const polys = extractRings(feat.geometry!);
    polyGroupStart.push(polyGroupCount);
    for (const rings of polys) {
      ringGroupStart.push(coordArrays.length);
      polyGroupCount++;
      for (const ring of rings) {
        const f64 = new Float64Array(ring.flat());
        coordArrays.push(f64);
        ringToFeature.push(fi);
        // Compute per-ring bbox from the flat coordinate array
        ringBboxes.push(...computeRingBbox(f64));
      }
    }
  }
  polyGroupStart.push(polyGroupCount);
  ringGroupStart.push(coordArrays.length);

  const nf = features.length, npg = ringGroupStart.length - 1, nr = coordArrays.length;

  // Compute buffer size
  const enc = new TextEncoder();
  const keyBytes = propKeys.map((k) => enc.encode(k));
  const colBytes = propColumns.map((col) => col.map((v) => enc.encode(v)));
  let size = 24; // 6 × uint32 header/metadata (magic,ver,nf,npg,nr,numProps)
  for (const b of keyBytes) size += 4 + b.length;
  size += nf * 4 * 8; // bboxes (Float64)
  for (const col of colBytes) for (const b of col) size += 4 + b.length;
  size += (nf + 1) * 4; // polyGroupStart
  size += (nr + 1) * 4;  // ringGroupStart
  size += nr * 4;        // ringToFeature
  for (const ca of coordArrays) size += 4 + ca.byteLength;
  size += nr * 4 * 8;    // ringBboxes (Float64) — v2+

  // Write buffer
  const buf = new ArrayBuffer(size);
  const ubuf = new Uint8Array(buf);
  let off = 0;

  const wu32 = (v: number) => { new DataView(buf, off, 4).setUint32(0, v, true); off += 4; };
  const wbytes = (src: Uint8Array) => { ubuf.set(src, off); off += src.length; };
  const wstr = (b: Uint8Array) => { wu32(b.length); wbytes(b); };

  wu32(MAGIC); wu32(VERSION); wu32(nf); wu32(npg); wu32(nr);
  wu32(propKeys.length);
  for (const b of keyBytes) wstr(b);
  wbytes(new Uint8Array(new Float64Array(bboxes).buffer));
  for (const col of colBytes) for (const b of col) wstr(b);
  wbytes(new Uint8Array(new Uint32Array(polyGroupStart).buffer));
  wbytes(new Uint8Array(new Uint32Array(ringGroupStart).buffer));
  wbytes(new Uint8Array(new Uint32Array(ringToFeature).buffer));
  for (const ca of coordArrays) {
    wu32(ca.length / 2);
    wbytes(new Uint8Array(ca.buffer, ca.byteOffset, ca.byteLength));
  }
  // v2+: ring bboxes
  wbytes(new Uint8Array(new Float64Array(ringBboxes).buffer));

  return buf;
}

// ── Point-in-polygon (custom, fast, flat, with ring bbox pruning) ──

function pointInRing(lon: number, lat: number, ring: Float64Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > lat) !== (yj > lat) && lon < xj + (xi - xj) * (lat - yj) / (yi - yj)) inside = !inside;
  }
  return inside;
}

export function pointInFeature(lon: number, lat: number, fi: number, data: GjbfData): boolean {
  let inside = false;
  const ps = data.polyGroupStart[fi], pe = data.polyGroupStart[fi + 1];
  const rb = data.ringBboxes;

  for (let pg = ps; pg < pe; pg++) {
    const rs = data.ringGroupStart[pg], re = data.ringGroupStart[pg + 1];

    // Prune: skip if point outside outer ring's bounding box
    if (rb && !pointInBbox(lon, lat, rb, rs)) continue;

    // Outer ring
    if (!pointInRing(lon, lat, data.coordArrays[rs])) continue;
    inside = !inside;

    // Holes (rings 1..N)
    for (let r = rs + 1; r < re; r++) {
      if (rb && !pointInBbox(lon, lat, rb, r)) continue;
      if (pointInRing(lon, lat, data.coordArrays[r])) inside = !inside;
    }
  }
  return inside;
}

/** Quick AABB check: is the point inside the ring's bounding box? */
function pointInBbox(lon: number, lat: number, bboxes: Float64Array, ringIdx: number): boolean {
  const off = ringIdx * 4;
  return lon >= bboxes[off] && lat >= bboxes[off + 1] &&
         lon <= bboxes[off + 2] && lat <= bboxes[off + 3];
}

// ── Helpers ─────────────────────────────────────────────────────────

function computeBbox(coords: unknown): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function visit(c: unknown) {
    if (!Array.isArray(c)) return;
    if (c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
      const x = c[0] as number, y = c[1] as number;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      return;
    }
    for (const ch of c) visit(ch);
  }
  visit(coords);
  return [minX, minY, maxX, maxY];
}

/** Compute bounding box of a flat Float64Array ring [lon,lat,lon,lat,...] */
function computeRingBbox(ring: Float64Array): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const x = ring[i], y = ring[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function extractRings(geom: Polygon | MultiPolygon): number[][][] {
  if (geom.type === "Polygon") return [geom.coordinates.map((r: unknown) => (r as number[][]).flat())];
  return geom.coordinates.map((p) => p.map((r: unknown) => (r as number[][]).flat()));
}