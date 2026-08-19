/**
 * Preprocess GeoJSON → .gjbf binary format + multi-resolution .grid
 *
 * Strips GeoJSON down to raw essentials:
 *  - Flattened polygon coordinates (Float64Array)
 *  - Bboxes (Float64Array)
 *  - Property values (strings)
 *
 * Grid: 1° base level with adaptive 0.2° refinement for dense cells.
 * No JSON.parse needed at runtime.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "data-src");        // raw .geojson source (not shipped)
const OUT_DIR = join(__dirname, "..", "public", "data");  // generated binary assets (shipped)
const outPath = (src, ext) => join(OUT_DIR, basename(src).replace(/\.geojson$/, ext));

const GJBF_MAGIC = 0x4642_4a47;
const GJBF_VERSION = 4;

/** Fixed-point scale for stored coordinates — MUST match COORD_SCALE in
 *  src/geo/binaryFormat.ts. degrees × 1e6 ≈ 11 cm, half the bytes of Float64. */
const COORD_SCALE = 1e6;

const GRID_MAGIC = 0x44495247;
const GRID_VERSION = 2;

const BASE_CELL_SIZE = 1.0;
const GRID_ORIGIN_LAT = -90;
const GRID_ORIGIN_LON = -180;
const GRID_NUM_LAT = 180;
const GRID_NUM_LON = 360;
const GRID_TOTAL_CELLS = GRID_NUM_LAT * GRID_NUM_LON;

const REFINE_THRESHOLD = 20;
const SUB_DIVISIONS = 5;
const SUB_CELL_SIZE = BASE_CELL_SIZE / SUB_DIVISIONS; // 0.2°

/**
 * Read a source file as strict UTF-8.
 *
 * Census/TIGER-derived GeoJSON is sometimes shipped as Latin-1/CP1252. Reading
 * that as UTF-8 silently replaces every accented byte with U+FFFD, so
 * "Doña Ana" ships as "Do�a Ana". Fail the build instead of baking the
 * corruption into the .gjbf.
 */
function readUtf8(path) {
  const buf = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(
      `${basename(path)} is not valid UTF-8 (likely Latin-1/CP1252). Re-encode it first, e.g.\n` +
      `  iconv -f CP1252 -t UTF-8 ${path} -o ${path}.utf8 && mv ${path}.utf8 ${path}`
    );
  }
}

/** Normalize property text: collapse whitespace runs (incl. NBSP, which `\s` matches) and trim. */
const clean = (v) => v.replace(/\s+/g, " ").trim();

function getBbox(feature) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function visit(coords) {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
      const x = coords[0], y = coords[1];
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) visit(c);
  }
  visit(feature.geometry?.coordinates);
  return [minX, minY, maxX, maxY];
}

function extractRings(geometry) {
  const result = [];
  if (geometry.type === "Polygon") {
    const rings = [];
    for (const ring of geometry.coordinates) {
      rings.push(ring.flat());
    }
    result.push(rings);
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      const rings = [];
      for (const ring of polygon) {
        rings.push(ring.flat());
      }
      result.push(rings);
    }
  }
  return result;
}

/** Compute bounding box of a flat ring array */
function computeRingBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], y = ring[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// ── Short-to-long property key mapping for translation CSVs ─────

/** Short + long property keys per layer. null means use the same as short (no translation). */
const FILE_KEYS = {
  "countries.geojson":       { short: "ISO_A3",    long: "ADMIN" },
  "us-states.geojson":       { short: "STUSPS",   long: "NAME" },
  "us-counties.geojson":     { short: "NAME",     long: null },
  "us-zctas.geojson":        { short: "ZCTA5CE20", long: null },
  "balancing-authorities.geojson": { short: "BA_Abbrev", long: "BAL_AUTH" },
  "nerc-regions.geojson":    { short: "NERC",     long: "NERC_Label" },
  "admin1.geojson":          { short: "name",     long: null },
  "retail-territories.geojson": { short: "name",   long: null },
  "control-areas.geojson":   { short: "NAME",     long: null },
};

/**
 * Selectable output properties per layer (the dropdown the user sees).
 * First entry = default. `col` is the stored/exposed key (must match the
 * manifest's `properties[].key`); `from` is the raw GeoJSON property.
 * KEEP IN SYNC with public/data/manifest.json.
 */
const PROPERTIES = {
  "countries.geojson": [
    { col: "ADMIN", from: "ADMIN", label: "Name" },
    { col: "ISO_A3", from: "ISO_A3", label: "ISO code (3)" },
    { col: "ISO_A2", from: "ISO_A2", label: "ISO code (2)" },
    { col: "CONTINENT", from: "CONTINENT", label: "Continent" },
  ],
  "us-states.geojson": [
    { col: "NAME", from: "NAME", label: "Name" },
    { col: "USPS", from: "STUSPS", label: "USPS code" },
    { col: "FIPS", from: "STATEFP", label: "FIPS code" },
  ],
  "us-counties.geojson": [
    { col: "NAME", from: "NAME", label: "Name" },
    { col: "COUNTY", from: "COUNTYFP", label: "County FIPS" },
    { col: "STATEFP", from: "STATEFP", label: "State FIPS" },
  ],
  "us-zctas.geojson": [
    { col: "ZCTA5", from: "ZCTA5CE20", label: "ZIP Code (ZCTA)" },
  ],
  "balancing-authorities.geojson": [
    { col: "BAL_AUTH", from: "BAL_AUTH", label: "Name" },
    { col: "BA_Abbrev", from: "BA_Abbrev", label: "Abbreviation" },
  ],
  "nerc-regions.geojson": [
    { col: "NERC_Label", from: "NERC_Label", label: "Name" },
    { col: "NERC", from: "NERC", label: "Code" },
  ],
  "admin1.geojson": [
    { col: "name", from: "name", label: "Name" },
    { col: "country", from: "country", label: "Country" },
    { col: "iso_a3", from: "iso_a3", label: "Country ISO (3)" },
  ],
  "control-areas.geojson": [
    { col: "NAME", from: "NAME", label: "Name" },
    { col: "ID", from: "ID", label: "EIA ID" },
    { col: "STATE", from: "STATE", label: "State" },
  ],
  "retail-territories.geojson": [
    { col: "name", from: "name", label: "Name" },
    { col: "type", from: "type", label: "Ownership type" },
    { col: "state", from: "state", label: "State" },
    { col: "hold_co", from: "hold_co", label: "Holding company" },
    { col: "ctrl_area", from: "ctrl_area", label: "Control area" },
    { col: "customers", from: "customers", label: "Customers" },
  ],
};

function processFile(geojsonPath) {
  console.log(`  ${geojsonPath}`);
  const geojson = JSON.parse(readUtf8(geojsonPath));

  const features = geojson.features.filter(f =>
    f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  );

  // Use expected short/long keys from known layers, or fall back to first key
  const filename = basename(geojsonPath);
  const fileKeys = FILE_KEYS[filename] ?? null;
  let propKey = fileKeys?.short ?? null;
  let longKey = fileKeys?.long ?? null;
  if (!propKey) {
    for (const feat of features) {
      if (feat.properties) {
        const keys = Object.keys(feat.properties);
        if (keys.length) { propKey = keys[0]; break; }
      }
    }
  }

  // Selectable property columns baked into the .gjbf (v3). First = default.
  const propDefs = PROPERTIES[filename] ?? (propKey ? [{ col: propKey, from: propKey }] : []);

  const bboxes = [];
  const propValues = [];
  const columns = propDefs.map(() => []); // column-major values per propDef
  const longPropValues = [];
  const coordArrays = [];
  const ringToFeature = [];
  const polyGroupStart = [];
  const ringGroupStart = [];
  const ringBboxes = []; // [minLon, minLat, maxLon, maxLat] per ring
  let polyGroupCount = 0;

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const bbox = getBbox(feat);
    bboxes.push(bbox[0], bbox[1], bbox[2], bbox[3]);

    const pv = propKey ? clean(String(feat.properties?.[propKey] ?? "")) : "";
    propValues.push(pv);

    // Bake each selectable property column for this feature
    for (let p = 0; p < propDefs.length; p++) {
      columns[p].push(clean(String(feat.properties?.[propDefs[p].from] ?? "")));
    }

    // Collect long value for translation CSV. A blank short code is not a
    // translation — admin-1 units with no ISO 3166-2 match would otherwise
    // contribute a single empty row to the CSV.
    if (longKey && pv) {
      const lv = clean(String(feat.properties?.[longKey] ?? ""));
      if (!longPropValues.find(([s]) => s === pv)) {
        longPropValues.push([pv, lv]);
      }
    }

    const polygonGroups = extractRings(feat.geometry);
    polyGroupStart.push(polyGroupCount);
    for (const rings of polygonGroups) {
      ringGroupStart.push(coordArrays.length);
      polyGroupCount++;
      for (const ring of rings) {
        // Quantize first, then derive the bbox from the quantized ring so the
        // runtime bbox prune can never reject a point the ring test would accept.
        const i32 = Int32Array.from(ring, (v) => Math.round(v * COORD_SCALE));
        coordArrays.push(i32);
        ringToFeature.push(fi);
        const rb = computeRingBbox(i32);
        ringBboxes.push(rb[0], rb[1], rb[2], rb[3]);
      }
    }
  }

  polyGroupStart.push(polyGroupCount);
  ringGroupStart.push(coordArrays.length);

  const numFeatures = features.length;
  const numPolyGroups = ringGroupStart.length - 1;
  const numRings = coordArrays.length;

  // Compute GJBF buffer size (v3: numProps + per-prop keys + column-major values)
  let bufSize = 6 * 4; // magic, ver, nf, npg, nr, numProps
  const keyBufs = propDefs.map((d) => Buffer.from(d.col, "utf-8"));
  for (const kb of keyBufs) bufSize += 4 + kb.length;
  bufSize += numFeatures * 4 * 8;
  for (const col of columns) for (const v of col) bufSize += 4 + Buffer.byteLength(v, "utf-8");
  bufSize += (numFeatures + 1) * 4;
  bufSize += ringGroupStart.length * 4;
  bufSize += numRings * 4;
  for (const ca of coordArrays) bufSize += 4 + ca.byteLength;
  bufSize += numRings * 4 * 4; // ring bboxes (Int32, v4+)

  const gjbf = Buffer.alloc(bufSize);
  let off = 0;

  const wu32 = (v) => { gjbf.writeUInt32LE(v, off); off += 4; };
  wu32(GJBF_MAGIC); wu32(GJBF_VERSION); wu32(numFeatures);
  wu32(numPolyGroups); wu32(numRings);
  wu32(propDefs.length);
  for (const kb of keyBufs) { wu32(kb.length); kb.copy(gjbf, off); off += kb.length; }
  Buffer.from(new Float64Array(bboxes).buffer).copy(gjbf, off); off += numFeatures * 4 * 8;
  for (const col of columns) for (const v of col) {
    const p = Buffer.from(v, "utf-8");
    wu32(p.length); p.copy(gjbf, off); off += p.length;
  }
  Buffer.from(new Uint32Array(polyGroupStart).buffer).copy(gjbf, off); off += (numFeatures + 1) * 4;
  Buffer.from(new Uint32Array(ringGroupStart).buffer).copy(gjbf, off); off += ringGroupStart.length * 4;
  Buffer.from(new Uint32Array(ringToFeature).buffer).copy(gjbf, off); off += numRings * 4;
  for (const ca of coordArrays) {
    wu32(ca.length / 2);
    Buffer.from(ca.buffer).copy(gjbf, off); off += ca.byteLength;
  }
  // v4: ring bounding boxes (Int32, COORD_SCALE units)
  if (ringBboxes.length > 0) {
    Buffer.from(new Int32Array(ringBboxes).buffer).copy(gjbf, off); off += numRings * 4 * 4;
  }

  const gjbfPath = outPath(geojsonPath, ".gjbf");
  writeFileSync(gjbfPath, gjbf);

  const inBytes = statSync(geojsonPath).size;
  console.log(`    → ${basename(gjbfPath)}  (${(gjbf.length / 1024 / 1024).toFixed(1)} MB, ${(gjbf.length / inBytes * 100).toFixed(1)}% of GeoJSON)`);

  // ── Translation CSV ─────────────────────────────────────────────────
  if (longPropValues.length > 0) {
    // Deduplicate by short value (handles multiple features with same short code)
    const seen = new Set();
    const unique = longPropValues.filter(([s]) => { if (seen.has(s)) return false; seen.add(s); return true; });
    const lines = unique.map(([s, l]) => `"${s}","${l}"`);
    const tsv = `short,long\n${lines.join("\n")}\n`;
    const transPath = outPath(geojsonPath, ".translation.csv");
    writeFileSync(transPath, tsv);
    console.log(`    → ${basename(transPath)}  (${tsv.length} bytes, ${unique.length} entries)`);
  }

  // ── Generate multi-resolution .grid file ─────────────────
  writeGridFile(geojsonPath, numFeatures, bboxes);
}

function writeGridFile(geojsonPath, numFeatures, bboxes) {
  const bboxArr = new Float64Array(bboxes);

  // ── Phase 1: Build 1° base grid ─────────────────────────
  const gridTable = new Uint32Array(GRID_TOTAL_CELLS);
  gridTable.fill(0xffffffff);
  const buckets = [];
  const bucketMap = new Uint32Array(GRID_TOTAL_CELLS);
  bucketMap.fill(0xffffffff);

  for (let fi = 0; fi < numFeatures; fi++) {
    const bb = bboxArr;
    const minLon = bb[fi * 4];
    const minLat = bb[fi * 4 + 1];
    const maxLon = bb[fi * 4 + 2];
    const maxLat = bb[fi * 4 + 3];

    const cMinLat = Math.max(0, Math.floor((minLat - GRID_ORIGIN_LAT) / BASE_CELL_SIZE));
    const cMaxLat = Math.min(GRID_NUM_LAT - 1, Math.floor((maxLat - GRID_ORIGIN_LAT) / BASE_CELL_SIZE));
    const cMinLon = Math.max(0, Math.floor((minLon - GRID_ORIGIN_LON) / BASE_CELL_SIZE));
    const cMaxLon = Math.min(GRID_NUM_LON - 1, Math.floor((maxLon - GRID_ORIGIN_LON) / BASE_CELL_SIZE));

    for (let clat = cMinLat; clat <= cMaxLat; clat++) {
      for (let clon = cMinLon; clon <= cMaxLon; clon++) {
        const cellIdx = clat * GRID_NUM_LON + clon;
        let bIdx = bucketMap[cellIdx];
        if (bIdx === 0xffffffff) {
          bIdx = buckets.length;
          bucketMap[cellIdx] = bIdx;
          buckets.push([fi]);
        } else {
          buckets[bIdx].push(fi);
        }
      }
    }
  }

  // ── Phase 2: Refine dense cells ─────────────────────────
  const flatParts = [];
  const segTable = new Uint32Array(GRID_TOTAL_CELLS);
  segTable.fill(0xffffffff);
  let globalOff = 0;

  for (let cellIdx = 0; cellIdx < GRID_TOTAL_CELLS; cellIdx++) {
    const bIdx = bucketMap[cellIdx];
    if (bIdx === 0xffffffff) continue;
    const bucket = buckets[bIdx];

    if (bucket.length <= REFINE_THRESHOLD) {
      // Normal cell
      const e = new Uint32Array(1 + bucket.length);
      e[0] = bucket.length;
      for (let i = 0; i < bucket.length; i++) e[1 + i] = bucket[i];
      segTable[cellIdx] = globalOff;
      flatParts.push(e);
      globalOff += e.length;
    } else {
      // Refined cell: 5×5 sub-cells at 0.2°
      const cellLat = Math.floor(cellIdx / GRID_NUM_LON);
      const cellLon = cellIdx % GRID_NUM_LON;
      const cellOriginLat = GRID_ORIGIN_LAT + cellLat * BASE_CELL_SIZE;
      const cellOriginLon = GRID_ORIGIN_LON + cellLon * BASE_CELL_SIZE;

      const subSz = SUB_DIVISIONS * SUB_DIVISIONS;
      const subBuckets = Array.from({ length: subSz }, () => []);

      for (const fi of bucket) {
        const bb = bboxArr;
        const minLon = bb[fi * 4];
        const minLat = bb[fi * 4 + 1];
        const maxLon = bb[fi * 4 + 2];
        const maxLat = bb[fi * 4 + 3];

        const clipMinLon = Math.max(minLon, cellOriginLon);
        const clipMinLat = Math.max(minLat, cellOriginLat);
        const clipMaxLon = Math.min(maxLon, cellOriginLon + BASE_CELL_SIZE);
        const clipMaxLat = Math.min(maxLat, cellOriginLat + BASE_CELL_SIZE);

        const scMinLat = Math.max(0, Math.floor((clipMinLat - cellOriginLat) / SUB_CELL_SIZE));
        const scMaxLat = Math.min(SUB_DIVISIONS - 1, Math.floor((clipMaxLat - cellOriginLat) / SUB_CELL_SIZE));
        const scMinLon = Math.max(0, Math.floor((clipMinLon - cellOriginLon) / SUB_CELL_SIZE));
        const scMaxLon = Math.min(SUB_DIVISIONS - 1, Math.floor((clipMaxLon - cellOriginLon) / SUB_CELL_SIZE));

        for (let clat = scMinLat; clat <= scMaxLat; clat++) {
          for (let clon = scMinLon; clon <= scMaxLon; clon++) {
            subBuckets[clat * SUB_DIVISIONS + clon].push(fi);
          }
        }
      }

      const subParts = [];
      const subOffsets = new Uint32Array(subSz);
      for (let s = 0; s < subSz; s++) {
        const sb = subBuckets[s];
        if (sb.length === 0) {
          subOffsets[s] = 0xffffffff;
        } else {
          subOffsets[s] = subParts.length;
          subParts.push(sb.length);
          for (const fi of sb) subParts.push(fi);
        }
      }

      const hdrLen = 3; // [0, subDiv, subTableSz]
      const e = new Uint32Array(hdrLen + subSz + subParts.length);
      e[0] = 0; // refined cell marker
      e[1] = SUB_DIVISIONS;
      e[2] = subSz;
      for (let s = 0; s < subSz; s++) e[hdrLen + s] = subOffsets[s];
      for (let i = 0; i < subParts.length; i++) e[hdrLen + subSz + i] = subParts[i];

      segTable[cellIdx] = globalOff;
      flatParts.push(e);
      globalOff += e.length;
    }
  }

  // ── Phase 3: Combine ─────────────────────────────────────
  let total = 0;
  for (const p of flatParts) total += p.length;
  const flatFeatures = new Uint32Array(total);
  let w = 0;
  for (const p of flatParts) { flatFeatures.set(p, w); w += p.length; }
  for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
    if (segTable[i] !== 0xffffffff) gridTable[i] = segTable[i];
  }

  let nonEmpty = 0;
  for (let i = 0; i < GRID_TOTAL_CELLS; i++) if (gridTable[i] !== 0xffffffff) nonEmpty++;

  // Count refinements for logging
  let refined = 0;
  for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
    const off = gridTable[i];
    if (off !== 0xffffffff && flatFeatures[off] === 0) refined++;
  }

  // ── Write binary ─────────────────────────────────────────
  const hdrSize = 4 + 4 + 8 + 8 + 8 + 4 + 4 + 4; // 40 bytes
  const tableBytes = gridTable.byteLength;
  const flatBytes = flatFeatures.byteLength;
  const buf = Buffer.alloc(hdrSize + 4 + tableBytes + flatBytes);
  let off = 0;

  buf.writeUInt32LE(GRID_MAGIC, off); off += 4;
  buf.writeUInt32LE(GRID_VERSION, off); off += 4;
  buf.writeDoubleLE(BASE_CELL_SIZE, off); off += 8;
  buf.writeDoubleLE(GRID_ORIGIN_LAT, off); off += 8;
  buf.writeDoubleLE(GRID_ORIGIN_LON, off); off += 8;
  buf.writeUInt32LE(GRID_NUM_LAT, off); off += 4;
  buf.writeUInt32LE(GRID_NUM_LON, off); off += 4;
  buf.writeUInt32LE(nonEmpty, off); off += 4;

  Buffer.from(gridTable.buffer).copy(buf, off); off += tableBytes;
  Buffer.from(flatFeatures.buffer).copy(buf, off); off += flatBytes;

  const gridPath = outPath(geojsonPath, ".grid");
  writeFileSync(gridPath, buf.subarray(0, off));

  console.log(`    → ${basename(gridPath)}  (${(off / 1024).toFixed(1)} KB, ${nonEmpty} non-empty, ${refined} refined)`);
}

// Main
console.log("Preprocessing GeoJSON → binary (.gjbf + .grid)...\n");
const files = readdirSync(SRC_DIR).filter(f => f.endsWith(".geojson")).sort();
for (const file of files) processFile(join(SRC_DIR, file));
console.log("\nDone.");