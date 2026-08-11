export type MultipleMatchMode = "first" | "join" | "all";

export type LayerSource = "builtin" | "uploaded";

/** A selectable output property for a layer, with a human-friendly label. */
export interface PropertyOption {
  key: string;
  label: string;
  /** Illustrative example value shown in the UI to clarify the column. */
  example?: string;
}

export interface LayerConfig {
  id: string;
  label: string;
  /** Base name for the output column, before the property suffix. */
  suggestion: string;
  source: LayerSource;
  url?: string;
  /** Selected property keys to output — one CSV column per key. */
  propertyKeys: string[];
  /** Properties the user can choose to output for this layer. */
  availableProperties: PropertyOption[];
  color?: string;
}

export interface ManifestEntry {
  id: string;
  label: string;
  url: string;
  gjbfUrl: string;
  gridUrl?: string;
  translationUrl?: string;
  defaultPropertyKey: string;
  /** Selectable output properties with friendly labels (first = default). */
  properties?: PropertyOption[];
  translatedFrom?: string;
  translatedTo?: string;
  suggestion?: string;
  color?: string;
}

export interface CsvRow {
  [key: string]: string;
}

export interface ProgressMessage {
  type: "progress";
  phase: string;
  processed: number;
  total: number;
  percent: number;
  previewRows: CsvRow[];
  matchStats: MatchStats;
}

export interface CompleteMessage {
  type: "complete";
  outputRows: CsvRow[];
  previewRows: CsvRow[];
  totalRows: number;
  matchStats: MatchStats;
}

export interface ErrorMessage {
  type: "error";
  errors: string[];
}

export type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

/** One property → output column pairing within a layer job. */
export interface LayerOutput {
  propertyKey: string;
  outputColumn: string;
}

export interface LayerJob {
  id: string;
  /** One or more property→column outputs produced from this layer. */
  outputs: LayerOutput[];
  multipleMatchMode: MultipleMatchMode;
  /** Format: "binary" loads from ArrayBuffer; "geojson" falls back to FeatureCollection */
  format: "binary" | "geojson";
  binaryBuffer?: ArrayBuffer;
  /** Precomputed 1°×1° spatial grid index */
  gridBuffer?: ArrayBuffer;
  geojson?: GeoJSON.FeatureCollection;
  /** Override grid refinement threshold for this layer. Default 20. */
  refineThreshold?: number;
  /** Override grid sub-divisions per dense cell. Default 5. */
  subDivisions?: number;
}

export interface MatchStats {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  badCoordRows: number;
}


