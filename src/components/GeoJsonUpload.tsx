import { useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import type { LayerConfig, PropertyOption } from "../geo/types";
import { deriveOutputColumns } from "../geo/layerConfig";
import { parseKml } from "../geo/kmlParser";
import { parseKmz } from "../geo/kmzParser";
import { useDragDrop } from "../hooks/useDragDrop";

/** Validate parsed GeoJSON, return error string or null */
function validateGeoJson(data: any): string | null {
  if (!data || typeof data !== "object") return "File must be a valid GeoJSON object.";
  if (data.type !== "FeatureCollection") return `Expected FeatureCollection, got ${data.type}.`;
  if (!Array.isArray(data.features)) return "FeatureCollection has no features array.";
  if (data.features.length === 0) return "FeatureCollection is empty — no features found.";
  for (let i = 0; i < data.features.length; i++) {
    const f = data.features[i];
    if (!f || typeof f !== "object") return `Feature ${i}: not a valid object.`;
    if (!f.geometry) return `Feature ${i}: missing geometry.`;
    if (!f.geometry.type) return `Feature ${i}: geometry has no type.`;
    if (!["Polygon","MultiPolygon"].includes(f.geometry.type)) {
      return `Feature ${i}: geometry type "${f.geometry.type}" not supported (only Polygon/MultiPolygon).`;
    }
    if (!Array.isArray(f.geometry.coordinates)) return `Feature ${i}: coordinates not an array.`;
  }
  return null;
}

/** Detect file format by extension */
type UploadFormat = "geojson" | "kml" | "kmz";

function detectFormat(name: string): UploadFormat {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "kml") return "kml";
  if (ext === "kmz") return "kmz";
  return "geojson";
}

interface Props {
  layers: LayerConfig[];
  onAdd: (config: LayerConfig, geojson: FeatureCollection) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<LayerConfig>) => void;
}

export default function GeoJsonUpload({ layers, onAdd, onRemove, onUpdate }: Props) {
  const [name, setName] = useState("");
  const [propertyKey, setPropertyKey] = useState("");
  const [availableProps, setAvailableProps] = useState<string[]>([]);
  const [geojson, setGeojson] = useState<FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setWarnings([]);
    setLoading(false);

    const format = detectFormat(file.name);

    try {
      if (format === "geojson") {
        await handleGeoJsonFile(file);
      } else if (format === "kml") {
        await handleKmlFile(file);
      } else if (format === "kmz") {
        await handleKmzFile(file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file.");
    }
  }

  async function handleGeoJsonFile(file: File) {
    const reader = new FileReader();
    const text = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file."));
      reader.readAsText(file);
    });

    const data = JSON.parse(text);
    const validationError = validateGeoJson(data);
    if (validationError) throw new Error(validationError);

    const fc = data as FeatureCollection;
    applyParsedData(fc, file);
  }

  async function handleKmlFile(file: File) {
    const reader = new FileReader();
    const text = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file."));
      reader.readAsText(file);
    });

    const result = parseKml(text);
    if (result.warnings.length > 0) {
      setWarnings(result.warnings);
    }
    applyParsedData(result.geojson, file, result.propertyKeys);
  }

  async function handleKmzFile(file: File) {
    setLoading(true);
    const reader = new FileReader();
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(new Error("Failed to read KMZ file."));
      reader.readAsArrayBuffer(file);
    });

    try {
      const result = await parseKmz(buffer);
      if (result.warnings.length > 0) {
        setWarnings(result.warnings);
      }
      applyParsedData(result.geojson, file, result.propertyKeys);
    } finally {
      setLoading(false);
    }
  }

  /** Set state from a parsed FeatureCollection (from any format) */
  function applyParsedData(
    fc: FeatureCollection,
    file: File,
    propertyKeys?: string[],
  ) {
    const props: string[] = propertyKeys ? [...propertyKeys] : [];
    if (!propertyKeys) {
      // GeoJSON: sample properties from features
      for (const f of fc.features) {
        if (f.properties) props.push(...Object.keys(f.properties));
      }
    }
    const unique = [...new Set(props)].filter(Boolean);

    setGeojson(fc);
    setAvailableProps(unique);
    setName(file.name.replace(/\.[^.]+$/, ""));
    setPropertyKey(unique[0] || "");
  }

  function handleAdd() {
    if (!geojson || !name || !propertyKey) {
      setError("Fill in name and property key.");
      return;
    }
    const availableProperties: PropertyOption[] = availableProps.map((k) => ({ key: k, label: k }));
    const config: LayerConfig = {
      id: `uploaded-${Date.now()}`,
      label: name,
      suggestion: name,
      source: "uploaded",
      propertyKeys: [propertyKey],
      availableProperties,
    };
    onAdd(config, geojson);
    reset();
  }

  function reset() {
    setName("");
    setPropertyKey("");
    setAvailableProps([]);
    setGeojson(null);
    setError(null);
    setWarnings([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  const { dragOver, dropProps } = useDragDrop(handleFile);

  const extLabel = ".json, .geojson, .kml, .kmz";

  return (
    <div
      className={`geojson-upload ${dragOver ? "drag-over" : ""}`}
      {...dropProps}
    >
      <h2>Custom Boundaries</h2>
      <p className="hint">Upload GeoJSON, KML, or KMZ boundary files.</p>

      <input
        ref={inputRef}
        type="file"
        accept=".json,.geojson,.kml,.kmz"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <button onClick={() => inputRef.current?.click()} disabled={loading}>
        {loading ? "Extracting KMZ..." : "Choose boundary file"}
      </button>

      {warnings.length > 0 && (
        <div className="kml-warnings">
          <p className="warning-title">Parse warnings:</p>
          {warnings.map((w, i) => (
            <p key={i} className="warning">{w}</p>
          ))}
        </div>
      )}

      {geojson && (
        <div className="upload-form">
          <label>
            Layer name:
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Output property:
            <select
              value={propertyKey}
              onChange={(e) => setPropertyKey(e.target.value)}
            >
              {availableProps.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <p className="prop-hint">
            Features: {geojson.features.length}. Available props: {availableProps.join(", ")}
          </p>
          <button className="btn-add" onClick={handleAdd}>
            Add Layer
          </button>
        </div>
      )}

      {error && <p className="warning">{error}</p>}

      {layers.length > 0 && (
        <div className="uploaded-layers">
          <h3>Uploaded Layers</h3>
          {layers.map((l) => {
            const cols = deriveOutputColumns(l.suggestion, l.availableProperties, l.propertyKeys);
            return (
              <div key={l.id} className="uploaded-layer">
                <span>{l.label} → {cols.map((c) => c.outputColumn).join(", ")}</span>
                <button className="btn-remove" onClick={() => onRemove(l.id)}>
                  Remove
                </button>
                <div className="uploaded-options">
                  <span className="layer-options-label">Output columns:</span>
                  {l.availableProperties.map((p) => {
                    const checked = l.propertyKeys.includes(p.key);
                    return (
                      <label key={p.key} className="property-toggle">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const set = new Set(l.propertyKeys);
                            if (e.target.checked) set.add(p.key);
                            else if (set.size > 1) set.delete(p.key);
                            onUpdate(l.id, { propertyKeys: Array.from(set) });
                          }}
                        />
                        <span>{p.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}