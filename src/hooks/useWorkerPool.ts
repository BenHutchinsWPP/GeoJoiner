/**
 * Multi-worker pool for parallel row processing.
 *
 * Spawns N workers, distributes CSV rows in chunks, merges results in order.
 * Workers each build their own indexed layers (cheap — uses pre-decoded buffers).
 */

import { useCallback, useRef } from "react";
import Papa from "papaparse";
import type {
  CompleteMessage,
  CsvRow,
  LayerJob,
  MatchStats,
  WorkerMessage,
} from "../geo/types";

interface WorkerPoolCallbacks {
  onProgress: (
    phase: string,
    processed: number,
    total: number,
    percent: number,
    previewRows: CsvRow[],
    matchStats: MatchStats,
  ) => void;
  onComplete: (msg: CompleteMessage) => void;
  onError: (errors: string[]) => void;
}

/** Minimum rows per chunk; below this, single-worker is faster */
const MIN_CHUNK_ROWS = 5000;
/** Max parallel workers */
const MAX_WORKERS = 4;

interface RunState {
  workers: Worker[];
  canceled: boolean;
  /** Resolves the in-flight run's promise; set while a run is active. */
  finish: (() => void) | null;
}

export function useWorkerPool() {
  const runRef = useRef<RunState>({ workers: [], canceled: false, finish: null });

  const start = useCallback(async (
    csvText: string,
    latColumn: string,
    lonColumn: string,
    layers: LayerJob[],
    callbacks: WorkerPoolCallbacks,
  ): Promise<void> => {
    // Clean up any leftover run (e.g. cancel followed immediately by a new run).
    for (const w of runRef.current.workers) w.terminate();
    runRef.current = { workers: [], canceled: false, finish: null };

    // Parse CSV in-memory first (main thread — fast)
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });

    if (parsed.errors.length > 0) {
      callbacks.onError(parsed.errors.map((e) => `Row ${e.row ?? "?"}: ${e.message}`));
      return;
    }

    const rows = parsed.data as CsvRow[];
    if (rows.length === 0) {
      callbacks.onError(["CSV has no data rows."]);
      return;
    }

    // For small datasets, use single worker (no pool overhead)
    const numWorkers = rows.length < MIN_CHUNK_ROWS
      ? 1
      : Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 4, Math.ceil(rows.length / MIN_CHUNK_ROWS));

    const chunkSize = Math.ceil(rows.length / numWorkers);

    callbacks.onProgress("Building spatial index", 0, 1, 0, [], {
      totalRows: rows.length, matchedRows: 0, unmatchedRows: 0, badCoordRows: 0,
    });

    const chunkResults: { outputRows: CsvRow[]; matchedCount: number; badCoordCount: number }[] = [];
    const errors: string[] = [];
    let completed = 0;

    // Per-chunk running totals, aggregated into onProgress as messages arrive.
    const chunkProcessed = new Array(numWorkers).fill(0);
    const chunkMatched = new Array(numWorkers).fill(0);
    const chunkBad = new Array(numWorkers).fill(0);
    let firstPreview: CsvRow[] = [];

    const reportProgress = (phase: string) => {
      const sumProcessed = chunkProcessed.reduce((a, b) => a + b, 0);
      const sumMatched = chunkMatched.reduce((a, b) => a + b, 0);
      const sumBad = chunkBad.reduce((a, b) => a + b, 0);
      callbacks.onProgress(
        phase,
        sumProcessed,
        rows.length,
        Math.round((sumProcessed / rows.length) * 95),
        firstPreview,
        {
          totalRows: rows.length,
          matchedRows: sumMatched,
          unmatchedRows: sumProcessed - sumMatched - sumBad,
          badCoordRows: sumBad,
        },
      );
    };

    await new Promise<void>((resolve) => {
      const settle = () => {
        runRef.current.finish = null;
        resolve();
      };
      runRef.current.finish = settle;

      for (let wi = 0; wi < numWorkers; wi++) {
        const startIdx = wi * chunkSize;
        const chunkRows = rows.slice(startIdx, startIdx + chunkSize);

        const worker = new Worker(
          new URL("../workers/geoProcessor.worker.ts", import.meta.url),
          { type: "module" },
        );

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const msg = event.data;
          if (msg.type === "progress") {
            chunkProcessed[wi] = msg.processed;
            chunkMatched[wi] = msg.matchStats.matchedRows;
            chunkBad[wi] = msg.matchStats.badCoordRows;
            if (wi === 0) firstPreview = msg.previewRows;
            reportProgress("Processing rows");
            return;
          }

          if (msg.type === "error") {
            errors.push(...msg.errors);
            worker.terminate();
            completed++;
          } else if (msg.type === "complete") {
            chunkResults[wi] = {
              outputRows: msg.outputRows,
              matchedCount: msg.matchStats.matchedRows,
              badCoordCount: msg.matchStats.badCoordRows,
            };
            chunkProcessed[wi] = chunkRows.length;
            chunkMatched[wi] = msg.matchStats.matchedRows;
            chunkBad[wi] = msg.matchStats.badCoordRows;
            worker.terminate();
            completed++;
          }

          if (completed >= numWorkers) settle();
        };

        worker.onerror = (err) => {
          errors.push(err.message || "Worker error");
          worker.terminate();
          completed++;
          if (completed >= numWorkers) settle();
        };

        worker.postMessage({ rows: chunkRows, latColumn, lonColumn, layers });
        runRef.current.workers.push(worker);
      }
    });

    if (runRef.current.canceled) return;

    if (errors.length > 0) {
      callbacks.onError(errors);
      return;
    }

    // Merge results in order
    const allOutputRows: CsvRow[] = [];
    let totalMatched = 0;
    let totalBadCoord = 0;
    for (const cr of chunkResults) {
      if (!cr) continue;
      for (const row of cr.outputRows) {
        allOutputRows.push(row);
      }
      totalMatched += cr.matchedCount;
      totalBadCoord += cr.badCoordCount;
    }

    const previewRows = allOutputRows.slice(0, 50);

    callbacks.onComplete({
      type: "complete",
      outputRows: allOutputRows,
      previewRows,
      totalRows: rows.length,
      matchStats: {
        totalRows: rows.length,
        matchedRows: totalMatched,
        unmatchedRows: rows.length - totalMatched - totalBadCoord,
        badCoordRows: totalBadCoord,
      },
    });
  }, []);

  const cancel = useCallback(() => {
    runRef.current.canceled = true;
    for (const w of runRef.current.workers) w.terminate();
    runRef.current.workers = [];
    runRef.current.finish?.();
  }, []);

  return { start, cancel };
}
