/**
 * All GeoJoiner state + orchestration: CSV/layer/processing/map/error state
 * and the handlers that drive the worker pool. App.tsx consumes this and is
 * pure layout. The actual matching runs in the worker (useWorkerPool).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import type { CompleteMessage, CsvRow, LayerConfig, LayerJob, MatchStats, ManifestEntry, MapPoint, MultipleMatchMode } from "../geo/types";
import { DOWNLOAD_PHASE } from "../geo/types";
import type { FeatureCollection } from "geojson";
import {
  loadManifest,
  fetchAllWithProgress,
  manifestToLayerConfig,
  resolveAssetUrl,
  deriveOutputColumns,
} from "../geo/layerConfig";
import { geoJsonToGjbfBuffer, decodeGjbf, gjbfToFeatureCollection, VERSION as GJBF_VERSION } from "../geo/binaryFormat";
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
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  // Boundary GeoJSON is produced on demand — decoding every layer up front
  // stalls the tab once the layers are tens of MB.
  const [mapLayers, setMapLayers] = useState<{ config: LayerConfig; getGeoJson: () => FeatureCollection }[]>([]);

  // Error state
  const [errors, setErrors] = useState<string[]>([]);

  // Global setting: how to handle a point that falls in multiple polygons
  const [matchMode, setMatchMode] = useState<MultipleMatchMode>("join");

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
      setSelectedLayers((prev) => [...prev, manifestToLayerConfig(entry)]);
    } else {
      setSelectedLayers((prev) => prev.filter((l) => l.id !== entry.id));
      setMapLayers((prev) => prev.filter((l) => l.config.id !== entry.id));
    }
  }, []);

  // Toggle one of a layer's output properties on/off (multi-select). Keeps at
  // least one property selected so the layer always produces a column.
  // Applies to builtin and uploaded layers alike — the id says which list it is in.
  const togglePropertyKey = useCallback((id: string, key: string, enabled: boolean) => {
    const toggle = (layers: LayerConfig[]) => layers.map((l) => {
      if (l.id !== id) return l;
      const set = new Set(l.propertyKeys);
      if (enabled) set.add(key);
      else if (set.size > 1) set.delete(key);
      return { ...l, propertyKeys: Array.from(set) };
    });
    setSelectedLayers(toggle);
    setUploadedLayers(toggle);
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
    // gjbf/grid buffers for builtin layers, also decoded into map boundaries in onComplete.
    const buffers = new Map<string, { gjbf: ArrayBuffer; grid?: ArrayBuffer }>();

    try {
      // Resolve builtin layer URLs and take whatever is already cached, so only
      // the missing files get downloaded (and counted in the progress total).
      const need: { layer: LayerConfig; gjbfUrl: string; gridUrl: string; cacheKey: string }[] = [];

      for (const layer of allLayers) {
        if (layer.source === "uploaded") continue;
        const entry = manifest.find((m) => m.id === layer.id);
        const gjbfUrl = resolveAssetUrl(entry?.gjbfUrl);
        const gridUrl = resolveAssetUrl(entry?.gridUrl) || gjbfUrl.replace(/\.gjbf$/, ".grid");
        // Format version in the key: a .gjbf cached before a format bump is
        // never read back, so decodeGjbf can hard-require the current version.
        const cacheKey = `v${GJBF_VERSION}:${gjbfUrl}`;
        const cached = await getCachedLayer(cacheKey);
        if (cached?.gjbf) buffers.set(layer.id, { gjbf: cached.gjbf, grid: cached.grid });
        else need.push({ layer, gjbfUrl, gridUrl, cacheKey });
      }

      if (need.length > 0) {
        setPhase(DOWNLOAD_PHASE);
        setPercent(0);
        const files = await fetchAllWithProgress(
          need.flatMap((n) => [n.gjbfUrl, n.gridUrl]),
          (loaded, total) => {
            setProcessed(loaded);
            // A gzipped response reports its compressed size, so the decoded
            // bytes can overshoot Content-Length — never show > 100%.
            setTotal(Math.max(total, loaded));
            setPercent(total ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
          },
        );
        for (const n of need) {
          const gjbf = files.get(n.gjbfUrl);
          if (!gjbf) throw new Error(`Failed to download boundary data for "${n.layer.label}"`);
          const grid = files.get(n.gridUrl); // optional — worker builds one if absent
          buffers.set(n.layer.id, { gjbf, grid });
          cacheLayer(n.cacheKey, { gjbf, grid }).catch(() => {});
        }
        setPhase("Processing");
        setProcessed(0);
        setTotal(0);
        setPercent(0);
      }

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
            binaryBuffer,
            gridBuffer,
          });
        } else {
          const { gjbf, grid } = buffers.get(layer.id)!;
          layerJobs.push({
            id: layer.id, outputs,
            multipleMatchMode: matchMode, binaryBuffer: gjbf, gridBuffer: grid,
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

      // Build map points from results. The whole joined row rides along so the
      // map can show it on hover and colour the point to match the polygon it
      // fell inside, without redoing any geometry work.
      const pts: MapPoint[] = [];
      for (const row of msg.outputRows) {
        const lat = Number(row[latColumn]);
        const lon = Number(row[lonColumn]);
        if (isFinite(lat) && isFinite(lon)) pts.push({ lat, lon, row });
      }
      setMapPoints(pts);

      // Build map boundary layers — reuse the gjbf buffers already loaded for
      // matching instead of re-fetching the raw .geojson source.
      const ml: { config: LayerConfig; getGeoJson: () => FeatureCollection }[] = [];
      for (const l of allLayers) {
        if (l.source === "uploaded") {
          const gj = uploadedGeoJsons.get(l.id);
          if (gj) ml.push({ config: l, getGeoJson: () => gj });
        } else {
          const buf = buffers.get(l.id)?.gjbf;
          if (!buf) continue;
          // Decoded once, on the first time the map actually shows this layer.
          let gj: FeatureCollection | null = null;
          ml.push({ config: l, getGeoJson: () => (gj ??= gjbfToFeatureCollection(decodeGjbf(buf))) });
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
    handleCsvLoaded, handleLayerToggle, togglePropertyKey,
    handleGeoJsonAdd, handleGeoJsonRemove,
    handleRun, handleCancel, handleDownload,
    canRun,
  };
}
