import Papa from "papaparse";
import type {
  CsvRow,
  LayerJob,
  LayerOutput,
  WorkerMessage,
} from "../geo/types";
import type {
  GjbfData,
} from "../geo/binaryFormat";
import {
  decodeGjbf,
  pointInFeature,
} from "../geo/binaryFormat";
import { isValidCoord } from "../geo/validation";
import {
  type GridIndex,
  buildGridFromGjbf,
  decodeGridFromBuffer,
  queryGrid,
} from "../geo/spatialGrid";

interface IndexedLayer {
  id: string;
  outputs: LayerOutput[];
  multipleMatchMode: "first" | "join" | "all";
  data: GjbfData;
  /** 1° spatial grid index — O(1) candidate lookup */
  grid: GridIndex;
}

interface ChunkRequest {
  rows: CsvRow[];
  latColumn: string;
  lonColumn: string;
  layers: LayerJob[];
}

self.onmessage = (event: MessageEvent<ChunkRequest>) => {
  runChunk(event.data);
};

function post(msg: WorkerMessage) {
  self.postMessage(msg);
}

/** Process a pre-parsed chunk of rows (multi-worker pool) */
function runChunk(request: ChunkRequest) {
  try {
    const rows = request.rows;
    const total = rows.length;
    if (total === 0) {
      post({ type: "complete", outputRows: [], previewRows: [], totalRows: 0,
        matchStats: { totalRows: 0, matchedRows: 0, unmatchedRows: 0, badCoordRows: 0 } });
      return;
    }

    const indexedLayers = request.layers.map(buildIndexedLayer);

    const outputRows: CsvRow[] = [];
    const previewRows: CsvRow[] = [];
    let matchedCount = 0;
    let badCoordCount = 0;
    const lastPreviewCount = Math.min(50, total);

    for (let i = 0; i < total; i++) {
      const row = rows[i];
      const lat = Number(row[request.latColumn]);
      const lon = Number(row[request.lonColumn]);
      const outputRow: CsvRow = { ...row };

      if (isValidCoord(lat, lon)) {
        let rowMatched = false;
        for (const layer of indexedLayers) {
          const matches = findLayerMatches(layer, lon, lat);
          for (const col in matches) {
            outputRow[col] = matches[col];
            if (matches[col]) rowMatched = true;
          }
        }
        if (rowMatched) matchedCount++;
      } else {
        badCoordCount++;
        for (const layer of indexedLayers) {
          for (const out of layer.outputs) outputRow[out.outputColumn] = "";
        }
      }

      outputRows.push(outputRow);
      if (previewRows.length < lastPreviewCount) previewRows.push(outputRow);

      if (i % 1000 === 0 || i === total - 1) {
        post({
          type: "progress", phase: "Processing rows", processed: i + 1, total,
          percent: Math.round(((i + 1) / total) * 95),
          previewRows: [...previewRows],
          matchStats: { totalRows: total, matchedRows: matchedCount,
            unmatchedRows: total - matchedCount - badCoordCount, badCoordRows: badCoordCount },
        });
      }
    }

    post({
      type: "complete",
      outputRows,
      previewRows,
      totalRows: outputRows.length,
      matchStats: { totalRows: total, matchedRows: matchedCount,
        unmatchedRows: total - matchedCount - badCoordCount, badCoordRows: badCoordCount },
    });

  } catch (err) {
    post({ type: "error", errors: [err instanceof Error ? err.message : "Unknown worker error"] });
  }
}

function buildIndexedLayer(input: LayerJob): IndexedLayer {
  if (!input.binaryBuffer) throw new Error(`Layer "${input.id}" has no binary data`);
  const data = decodeGjbf(input.binaryBuffer);

  // Precomputed grid from .grid file or build on-the-fly from GjbfData
  const grid = input.gridBuffer
    ? decodeGridFromBuffer(input.gridBuffer)
    : buildGridFromGjbf(data);

  return { id: input.id, outputs: input.outputs,
    multipleMatchMode: input.multipleMatchMode, data, grid };
}

/**
 * Match a point against one layer and return a value for each of the layer's
 * output columns. The grid lookup and point-in-polygon test run once per
 * candidate feature; every selected property is pulled from the same matched
 * feature(s), so extra output columns are nearly free.
 */
function findLayerMatches(layer: IndexedLayer, lon: number, lat: number): Record<string, string> {
  const { data, grid, multipleMatchMode, outputs } = layer;

  // Resolve each output's property column up front (fall back to default col).
  const cols = outputs.map((o) => ({
    outputColumn: o.outputColumn,
    column: data.propColumns[o.propertyKey] ?? data.propValues,
    matches: [] as string[],
  }));

  // O(1) grid lookup: 1° cell → flatFeatures offset → candidate feature indices
  const candidates = queryGrid(grid, lat, lon);

  if (candidates.count > 0) {
    const ff = grid.flatFeatures;
    const off = candidates.offset;
    for (let i = 0; i < candidates.count; i++) {
      const fi = ff[off + 1 + i];
      if (!pointInFeature(lon, lat, fi, data)) continue;

      for (const c of cols) {
        const val = c.column[fi];
        if (val !== undefined && val !== null && val !== "") c.matches.push(val);
      }
      if (multipleMatchMode === "first") break;
    }
  }

  const result: Record<string, string> = {};
  for (const c of cols) {
    result[c.outputColumn] = multipleMatchMode === "all"
      ? JSON.stringify(c.matches)
      : c.matches.join("; ");
  }
  return result;
}
