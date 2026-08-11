/**
 * All GeoJoiner state + orchestration: CSV/layer/processing/map/error state
 * and the handlers that drive the worker pool. App.tsx consumes this and is
 * pure layout. The actual matching runs in the worker (useWorkerPool).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import type { CompleteMessage, CsvRow, LayerConfig, LayerJob, MatchStats, ManifestEntry, MultipleMatchMode } from "../geo/types";
import type { FeatureCollection } from "geojson";
import {
  loadManifest,
  fetchBinaryLayer,
  fetchGrid,
  manifestToLayerConfig,
  resolveAssetUrl,
  deriveOutputColumns,
} from "../geo/layerConfig";
import { geoJsonToGjbfBuffer, decodeGjbf, gjbfToFeatureCollection } from "../geo/binaryFormat";
import { buildGridFromGjbf, encodeGridToBuffer } from "../geo/spatialGrid";
import { useWorkerPool } from "./useWorkerPool";
import { downloadText } from "../utils/download";
import { cacheLayer, getCachedLayer } from "../utils/layerCache";

export function useGeoJoin() {
  // CSV state
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [latColumn, setLatColumn] = useState("");
  const [lonColumn, setLonColumn] = useState("");

  // Layer state
  const [manifest, setManifest] = useState<ManifestEntry[]>([]);
  const [selectedLayers, setSelectedLayers] = useState<LayerConfig[]>([]);
  const [uploadedLayers, setUploadedLayers] = useState<LayerConfig[]>([]);
  const [uploadedGeoJsons, setUploadedGeoJsons] = useState<Map<string, FeatureCollection>>(new Map());

  // Processing state
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [percent, setPercent] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [matchStats, setMatchStats] = useState<MatchStats | null>(null);
  const [previewRows, setPreviewRows] = useState<CsvRow[]>([]);
  const [result, setResult] = useState<CompleteMessage | null>(null);

  // Map state
  const [mapPoints, setMapPoints] = useState<[number, number][]>([]);
  const [mapLayers, setMapLayers] = useState<{ config: LayerConfig; geojson: FeatureCollection }[]>([]);

  // Error state
  const [errors, setErrors] = useState<string[]>([]);

  // Global setting: how to handle a point that falls in multiple polygons
  const [matchMode, setMatchMode] = useState<MultipleMatchMode>("first");

  const { start, cancel } = useWorkerPool();
  // Tracks a cancel requested while still fetching layer data, before any
  // worker exists for useWorkerPool's cancel() to terminate.
  const canceledRef = useRef(false);

  // Load manifest on mount
  useEffect(() => {
    loadManifest().then(setManifest).catch((e) => {
      setErrors((prev) => [...prev, `Failed to load manifest: ${e.message}`]);
    });
  }, []);

  // CSV loaded — auto-detect lat/lon columns
  const handleCsvLoaded = useCallback((text: string, headers: string[]) => {
    setCsvText(text);
    setCsvHeaders(headers);
    setResult(null);
    setMatchStats(null);
    setPreviewRows([]);
    setMapPoints([]);
    setErrors([]);

    const latKey = headers.find(h => /^(lat|latitude|y|northing)$/i.test(h));
    const lonKey = headers.find(h => /^(lon|lng|longitude|x|easting)$/i.test(h));
    if (latKey) setLatColumn(latKey);
    if (lonKey) setLonColumn(lonKey);
  }, []);

  // Layer toggles
  const handleLayerToggle = useCallback(async (entry: ManifestEntry, enabled: boolean) => {
    if (enabled) {
      setSelectedLayers((prev) => [...prev, manifestToLayerConfig(entry, true)]);
    } else {
      setSelectedLayers((prev) => prev.filter((l) => l.id !== entry.id));
      setMapLayers((prev) => prev.filter((l) => l.config.id !== entry.id));
    }
  }, []);

  const updateLayer = useCallback((id: string, patch: Partial<LayerConfig>) => {
    setSelectedLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  // Toggle one of a layer's output properties on/off (multi-select). Keeps at
  // least one property selected so the layer always produces a column.
  const togglePropertyKey = useCallback((id: string, key: string, enabled: boolean) => {
    setSelectedLayers((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const set = new Set(l.propertyKeys);
      if (enabled) set.add(key);
      else if (set.size > 1) set.delete(key);
      return { ...l, propertyKeys: Array.from(set) };
    }));
  }, []);

  // Uploaded GeoJSON
  const handleGeoJsonAdd = useCallback((config: LayerConfig, geojson: FeatureCollection) => {
    setUploadedLayers((prev) => [...prev, { ...config, source: "uploaded" } as LayerConfig]);
    setUploadedGeoJsons((prev) => new Map(prev).set(config.id, geojson));
  }, []);

  const handleGeoJsonRemove = useCallback((id: string) => {
    setUploadedLayers((prev) => prev.filter((l) => l.id !== id));
    setUploadedGeoJsons((prev) => { const m = new Map(prev); m.delete(id); return m; });
  }, []);

  const handleGeoJsonUpdate = useCallback((id: string, patch: Partial<LayerConfig>) => {
    setUploadedLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  // Run
  const handleRun = useCallback(async () => {
    if (!csvText || !latColumn || !lonColumn) return;
    if (selectedLayers.length === 0 && uploadedLayers.length === 0) return;

    canceledRef.current = false;
    setRunning(true);
    setErrors([]);
    setResult(null);
    setMatchStats(null);
    setPreviewRows([]);
    setMapPoints([]);

    const allLayers = [...selectedLayers, ...uploadedLayers];
    const layerJobs: LayerJob[] = [];
    // gjbf buffers for builtin layers, decoded into map boundaries in onComplete.
    const layerBuffers = new Map<string, ArrayBuffer>();

    try {
      for (const layer of allLayers) {
        const outputs = deriveOutputColumns(layer.suggestion, layer.availableProperties, layer.propertyKeys);
        if (layer.source === "uploaded") {
          const geojson = uploadedGeoJsons.get(layer.id)!;
          if (!geojson) throw new Error(`Uploaded layer "${layer.label}" data missing.`);
          const binaryBuffer = geoJsonToGjbfBuffer(geojson);
          const data = decodeGjbf(binaryBuffer);
          const gridBuffer = encodeGridToBuffer(buildGridFromGjbf(data));
          layerJobs.push({
            id: layer.id,
            outputs,
            multipleMatchMode: matchMode,
            format: "binary",
            binaryBuffer,
            gridBuffer,
          });
        } else {
          const entry = manifest.find((m) => m.id === layer.id);
          const gjbfUrl = resolveAssetUrl(entry?.gjbfUrl) || layer.url?.replace(/\.geojson$/, ".gjbf");
          const gridUrl = resolveAssetUrl(entry?.gridUrl) || gjbfUrl?.replace(/\.gjbf$/, ".grid");
          const cacheKey = gjbfUrl!;

          // Try cache first
          let cached = await getCachedLayer(cacheKey);
          let buf = cached?.gjbf;
          let gridBuf = cached?.grid;

          if (!buf) {
            buf = await fetchBinaryLayer(gjbfUrl!);
            try { gridBuf = await fetchGrid(gridUrl!); } catch { /* non-fatal */ }
            cacheLayer(cacheKey, { gjbf: buf, grid: gridBuf }).catch(() => {});
          }
          layerBuffers.set(layer.id, buf);
          layerJobs.push({
            id: layer.id, outputs,
            multipleMatchMode: matchMode, format: "binary", binaryBuffer: buf, gridBuffer: gridBuf,
          });
        }
      }
    } catch (err) {
      setErrors((prev) => [...prev, err instanceof Error ? err.message : "Failed to load layer data"]);
      setRunning(false);
      return;
    }

    // Cancel may have been requested while still fetching layer data, before
    // any worker existed for useWorkerPool's cancel() to terminate.
    if (canceledRef.current) {
      setRunning(false);
      return;
    }

    const onComplete = (msg: CompleteMessage) => {
      setResult(msg);
      setRunning(false);
      setPercent(100);
      setMatchStats(msg.matchStats);
      setPreviewRows(msg.previewRows);

      // Build map points from results
      const pts: [number, number][] = [];
      for (const row of msg.outputRows) {
        const lat = Number(row[latColumn]);
        const lon = Number(row[lonColumn]);
        if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon]);
      }
      setMapPoints(pts);

      // Build map boundary layers — reuse the gjbf buffers already loaded for
      // matching instead of re-fetching the raw .geojson source.
      const ml: { config: LayerConfig; geojson: FeatureCollection }[] = [];
      for (const l of allLayers) {
        if (l.source === "uploaded") {
          const gj = uploadedGeoJsons.get(l.id);
          if (gj) ml.push({ config: l, geojson: gj });
        } else {
          const buf = layerBuffers.get(l.id);
          if (buf) ml.push({ config: l, geojson: gjbfToFeatureCollection(decodeGjbf(buf)) });
        }
      }
      setMapLayers(ml);
    };

    const onError = (errs: string[]) => {
      setErrors((prev) => [...prev, ...errs]);
      setRunning(false);
    };

    const onProgress = (ph: string, proc: number, tot: number, pct: number, preview: CsvRow[], stats: MatchStats) => {
      setPhase(ph);
      setProcessed(proc);
      setTotal(tot);
      setPercent(pct);
      setPreviewRows(preview);
      setMatchStats(stats);
    };

    await start(csvText, latColumn, lonColumn, layerJobs, { onProgress, onComplete, onError });
  }, [csvText, latColumn, lonColumn, selectedLayers, uploadedLayers, uploadedGeoJsons, start, csvHeaders, manifest, matchMode]);

  // Cancel
  const handleCancel = useCallback(() => {
    canceledRef.current = true;
    cancel();
    setRunning(false);
  }, [cancel]);

  // Download CSV result
  const handleDownload = useCallback(() => {
    if (!result) return;
    downloadText(Papa.unparse(result.outputRows), "geojoiner-output.csv", "text/csv");
  }, [result]);

  const canRun = !!(csvText && latColumn && lonColumn && (selectedLayers.length > 0 || uploadedLayers.length > 0));

  return {
    // CSV
    csvHeaders, latColumn, lonColumn, setLatColumn, setLonColumn,
    // layers
    manifest, selectedLayers, uploadedLayers,
    // processing
    running, phase, percent, processed, total, matchStats, previewRows, result,
    // map
    mapPoints, mapLayers,
    // errors
    errors, setErrors,
    // global match mode
    matchMode, setMatchMode,
    // handlers
    handleCsvLoaded, handleLayerToggle, updateLayer, togglePropertyKey,
    handleGeoJsonAdd, handleGeoJsonRemove, handleGeoJsonUpdate,
    handleRun, handleCancel, handleDownload,
    canRun,
  };
}
