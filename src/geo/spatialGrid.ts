import type { GjbfData } from "./binaryFormat";

// Constants
export const BASE_CELL_SIZE = 1.0;
export const GRID_ORIGIN_LAT = -90;
export const GRID_ORIGIN_LON = -180;
export const GRID_NUM_LAT = 180;
export const GRID_NUM_LON = 360;
export const GRID_TOTAL_CELLS = GRID_NUM_LAT * GRID_NUM_LON; // 64,800

/** Default threshold: refine 1° cells with more candidates than this */
export const REFINE_THRESHOLD = 20;
/** Default sub-divisions per dense cell (5 × 5 = 0.2° sub-cells) */
export const SUB_DIVISIONS = 5;
export const SUB_CELL_SIZE = BASE_CELL_SIZE / SUB_DIVISIONS; // 0.2°

// Types
export interface GridIndex {
  gridTable: Uint32Array;
  flatFeatures: Uint32Array;
  refineThreshold: number;
  subDivisions: number;
}

export interface GridQueryResult {
  count: number;
  offset: number;
  grid: GridIndex;
}

// ── Build from GjbfData ────────────────

export function buildGridFromGjbf(
  data: GjbfData,
  opts?: { refineThreshold?: number; subDivisions?: number },
): GridIndex {
  return buildGridFromBboxes(data.numFeatures, data.bboxes, {
    refineThreshold: opts?.refineThreshold ?? data.refineThreshold,
    subDivisions: opts?.subDivisions ?? data.subDivisions,
  });
}

function buildGridFromBboxes(
  numFeatures: number,
  bboxes: Float64Array,
  opts?: { refineThreshold?: number; subDivisions?: number },
): GridIndex {
  const refineThreshold = opts?.refineThreshold ?? REFINE_THRESHOLD;
  const subDivisions = opts?.subDivisions ?? SUB_DIVISIONS;
  const subCellSize = BASE_CELL_SIZE / subDivisions;

  // ── Phase 1: Build 1° base grid ────────
  const gridTable = new Uint32Array(GRID_TOTAL_CELLS);
  gridTable.fill(0xffffffff);
  const buckets: number[][] = [];
  const bucketMap = new Uint32Array(GRID_TOTAL_CELLS);
  bucketMap.fill(0xffffffff);

  for (let fi = 0; fi < numFeatures; fi++) {
    const minLon = bboxes[fi * 4];
    const minLat = bboxes[fi * 4 + 1];
    const maxLon = bboxes[fi * 4 + 2];
    const maxLat = bboxes[fi * 4 + 3];

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

  // ── Phase 2: Refine dense cells ────────────────
  const flatParts: Uint32Array[] = [];
  const segmentedTable = new Uint32Array(GRID_TOTAL_CELLS);
  segmentedTable.fill(0xffffffff);
  let globalOffset = 0;

  for (let cellIdx = 0; cellIdx < GRID_TOTAL_CELLS; cellIdx++) {
    const bIdx = bucketMap[cellIdx];
    if (bIdx === 0xffffffff) continue;

    const bucket = buckets[bIdx];
    const candidateCount = bucket.length;

    if (candidateCount <= refineThreshold) {
      // Normal cell
      const entry = new Uint32Array(1 + candidateCount);
      entry[0] = candidateCount;
      for (let i = 0; i < candidateCount; i++) entry[1 + i] = bucket[i];

      segmentedTable[cellIdx] = globalOffset;
      flatParts.push(entry);
      globalOffset += entry.length;
    } else {
      // Refined cell: subdivide into subDivisions × subDivisions sub-cells
      const cellLat = Math.floor(cellIdx / GRID_NUM_LON);
      const cellLon = cellIdx % GRID_NUM_LON;
      const cellOriginLat = GRID_ORIGIN_LAT + cellLat * BASE_CELL_SIZE;
      const cellOriginLon = GRID_ORIGIN_LON + cellLon * BASE_CELL_SIZE;

      const subTableSz = subDivisions * subDivisions;
      const subBuckets: number[][] = new Array(subTableSz);
      for (let s = 0; s < subTableSz; s++) subBuckets[s] = [];

      for (const fi of bucket) {
        const minLon = bboxes[fi * 4];
        const minLat = bboxes[fi * 4 + 1];
        const maxLon = bboxes[fi * 4 + 2];
        const maxLat = bboxes[fi * 4 + 3];

        // Clip to cell boundaries, then compute which sub-cells this feature overlaps
        const clipMinLon = Math.max(minLon, cellOriginLon);
        const clipMinLat = Math.max(minLat, cellOriginLat);
        const clipMaxLon = Math.min(maxLon, cellOriginLon + BASE_CELL_SIZE);
        const clipMaxLat = Math.min(maxLat, cellOriginLat + BASE_CELL_SIZE);

        const scMinLat = Math.max(0, Math.floor((clipMinLat - cellOriginLat) / subCellSize));
        const scMaxLat = Math.min(subDivisions - 1, Math.floor((clipMaxLat - cellOriginLat) / subCellSize));
        const scMinLon = Math.max(0, Math.floor((clipMinLon - cellOriginLon) / subCellSize));
        const scMaxLon = Math.min(subDivisions - 1, Math.floor((clipMaxLon - cellOriginLon) / subCellSize));

        for (let clat = scMinLat; clat <= scMaxLat; clat++) {
          for (let clon = scMinLon; clon <= scMaxLon; clon++) {
            const scIdx = clat * subDivisions + clon;
            subBuckets[scIdx].push(fi);
          }
        }
      }

      // Flatten sub-buckets into sub-data
      const subParts: number[] = [];
      const subOffsets = new Uint32Array(subTableSz);
      for (let s = 0; s < subTableSz; s++) {
        const sb = subBuckets[s];
        if (sb.length === 0) {
          subOffsets[s] = 0xffffffff;
        } else {
          subOffsets[s] = subParts.length;
          subParts.push(sb.length);
          for (const fi of sb) subParts.push(fi);
        }
      }

      // Refined cell header: [0, subDiv, subTableSz, subOffsets..., subParts...]
      const headerLen = 1 + 1 + 1; // marker(0), subDiv, subTableSz
      const entry = new Uint32Array(headerLen + subTableSz + subParts.length);
      entry[0] = 0; // refined cell marker
      entry[1] = subDivisions;
      entry[2] = subTableSz;
      for (let s = 0; s < subTableSz; s++) entry[headerLen + s] = subOffsets[s];
      for (let i = 0; i < subParts.length; i++) entry[headerLen + subTableSz + i] = subParts[i];

      segmentedTable[cellIdx] = globalOffset;
      flatParts.push(entry);
      globalOffset += entry.length;
    }
  }

  // ── Phase 3: Combine all flat parts ────────────────
  let totalLen = 0;
  for (const p of flatParts) totalLen += p.length;
  const flatFeatures = new Uint32Array(totalLen);
  let writeOff = 0;
  for (const p of flatParts) {
    flatFeatures.set(p, writeOff);
    writeOff += p.length;
  }

  // Map segmented offsets back to gridTable (flatFeatures offsets)
  for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
    if (segmentedTable[i] !== 0xffffffff) {
      gridTable[i] = segmentedTable[i];
    }
  }

  return { gridTable, flatFeatures, refineThreshold, subDivisions };
}

// ── Query ────────────────

export function queryGrid(grid: GridIndex, lat: number, lon: number): GridQueryResult {
  const ci = Math.floor((lat - GRID_ORIGIN_LAT) / BASE_CELL_SIZE);
  const cj = Math.floor((lon - GRID_ORIGIN_LON) / BASE_CELL_SIZE);

  if (ci < 0 || ci >= GRID_NUM_LAT || cj < 0 || cj >= GRID_NUM_LON) {
    return { count: 0, offset: 0, grid };
  }

  const offset = grid.gridTable[ci * GRID_NUM_LON + cj];
  if (offset === 0xffffffff) {
    return { count: 0, offset: 0, grid };
  }

  const ff = grid.flatFeatures;
  const entryCount = ff[offset];

  // Check if this is a refined cell (entryCount === 0)
  if (entryCount === 0) {
    return queryRefinedCell(grid, offset, lat, lon, ci, cj);
  }

  // Normal cell
  return { count: entryCount, offset, grid };
}

function queryRefinedCell(
  grid: GridIndex,
  baseOffset: number,
  lat: number,
  lon: number,
  baseLatIdx: number,
  baseLonIdx: number,
): GridQueryResult {
  const ff = grid.flatFeatures;
  const subDiv = ff[baseOffset + 1];
  const subTableSz = ff[baseOffset + 2]; // subDiv * subDiv

  // Determine sub-cell within this base cell
  const cellOriginLat = GRID_ORIGIN_LAT + baseLatIdx * BASE_CELL_SIZE;
  const cellOriginLon = GRID_ORIGIN_LON + baseLonIdx * BASE_CELL_SIZE;
  const subCellSize = BASE_CELL_SIZE / subDiv;

  const sci = Math.floor((lat - cellOriginLat) / subCellSize);
  const scj = Math.floor((lon - cellOriginLon) / subCellSize);

  if (sci < 0 || sci >= subDiv || scj < 0 || scj >= subDiv) {
    return { count: 0, offset: 0, grid };
  }

  const subIdx = sci * subDiv + scj;
  const subOffTableStart = baseOffset + 3; // right after [0, subDiv, subTableSz]
  const subOffset = ff[subOffTableStart + subIdx];

  if (subOffset === 0xffffffff) {
    return { count: 0, offset: 0, grid };
  }

  // Sub-data starts after the sub-offset table
  const subDataStart = subOffTableStart + subTableSz;
  const entryCount = ff[subDataStart + subOffset];
  const entryOffset = subDataStart + subOffset;

  return { count: entryCount, offset: entryOffset, grid };
}

// ── Codec ────────────────

const MAGIC = 0x44495247; // "GRID" as uint32 LE
const VERSION = 2; // bumped for refined encoding

export function encodeGridToBuffer(grid: GridIndex): ArrayBuffer {
  const headerSize = 4 + 4 + 8 + 8 + 8 + 4 + 4; // 40 bytes (no nonEmpty — computed on decode)
  const gridTableBytes = grid.gridTable.byteLength;
  const flatBytes = grid.flatFeatures.byteLength;

  // Add nonEmpty count after header
  let nonEmpty = 0;
  for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
    if (grid.gridTable[i] !== 0xffffffff) nonEmpty++;
  }

  const buf = new ArrayBuffer(headerSize + 4 + gridTableBytes + flatBytes);
  const view = new DataView(buf);
  let off = 0;

  // Header
  view.setUint32(off, MAGIC, true); off += 4;
  view.setUint32(off, VERSION, true); off += 4;
  view.setFloat64(off, BASE_CELL_SIZE, true); off += 8;
  view.setFloat64(off, GRID_ORIGIN_LAT, true); off += 8;
  view.setFloat64(off, GRID_ORIGIN_LON, true); off += 8;
  view.setUint32(off, GRID_NUM_LAT, true); off += 4;
  view.setUint32(off, GRID_NUM_LON, true); off += 4;
  view.setUint32(off, nonEmpty, true); off += 4;

  // Grid table
  const gridTableU8 = new Uint8Array(grid.gridTable.buffer, grid.gridTable.byteOffset, gridTableBytes);
  new Uint8Array(buf).set(gridTableU8, off);
  off += gridTableBytes;

  // Flat features
  const flatU8 = new Uint8Array(grid.flatFeatures.buffer, grid.flatFeatures.byteOffset, flatBytes);
  new Uint8Array(buf).set(flatU8, off);

  return buf;
}

export function decodeGridFromBuffer(buffer: ArrayBuffer): GridIndex {
  const view = new DataView(buffer);
  let off = 0;

  const magic = view.getUint32(off, true); off += 4;
  if (magic !== MAGIC) throw new Error(`Bad grid magic: 0x${magic.toString(16)}`);

  const version = view.getUint32(off, true); off += 4;
  if (version < 1 || version > VERSION) throw new Error(`Bad grid version: ${version}`);

  const cellSize = view.getFloat64(off, true); off += 8;
  if (cellSize !== BASE_CELL_SIZE) throw new Error(`Grid cell size mismatch: ${cellSize}`);

  const originLat = view.getFloat64(off, true); off += 8;
  const originLon = view.getFloat64(off, true); off += 8;
  const numLat = view.getUint32(off, true); off += 4;
  const numLon = view.getUint32(off, true); off += 4;
  const numNonEmpty = view.getUint32(off, true); off += 4;

  if (originLat !== GRID_ORIGIN_LAT || originLon !== GRID_ORIGIN_LON ||
      numLat !== GRID_NUM_LAT || numLon !== GRID_NUM_LON) {
    throw new Error(`Grid dimensions mismatch: ${originLat}/${originLon} ${numLat}x${numLon}`);
  }

  // Grid table: numLat * numLon * 4 bytes
  const gridTable = new Uint32Array(buffer, off, numLat * numLon);
  off += gridTable.byteLength;

  // Flat features: remaining bytes
  const flatBytes = buffer.byteLength - off;
  const flatFeatures = new Uint32Array(buffer, off, flatBytes / 4);

  return { gridTable, flatFeatures, refineThreshold: 20, subDivisions: 5 };
}
