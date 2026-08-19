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
  /** Public page documenting where this layer's boundaries come from. */
  sourceUrl?: string;
  /** Base name for the output column, before the property suffix. */
  suggestion: string;
  /** Short identifier drawn on the map ("WA" rather than "Washington"), where
   *  the layer has one. Falls back to the coloured property when unset. */
  labelKey?: string;
  source: LayerSource;
  /** Selected property keys to output — one CSV column per key. */
  propertyKeys: string[];
  /** Properties the user can choose to output for this layer. */
  availableProperties: PropertyOption[];
  color?: string;
}

export interface ManifestEntry {
  id: string;
  label: string;
  /** Heading this layer sits under in the picker. Consecutive entries sharing
   *  a group render as one section, so manifest order defines the grouping. */
  group?: string;
  /** Public page documenting where this layer's boundaries come from. */
  sourceUrl?: string;
  gjbfUrl: string;
  gridUrl?: string;
  /** Short identifier drawn on the map — see LayerConfig.labelKey. */
  labelKey?: string;
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

/** One plotted point: its coordinates plus the full joined output row, so the
 *  map can colour and label it without re-running the point-in-polygon test. */
export interface MapPoint {
  lat: number;
  lon: number;
  row: CsvRow;
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
  binaryBuffer?: ArrayBuffer;
  /** Precomputed 1°×1° spatial grid index */
  gridBuffer?: ArrayBuffer;
}

/** Phase label used while boundary files are downloading (progress in MB, not rows). */
export const DOWNLOAD_PHASE = "Downloading boundary data";

export interface MatchStats {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  badCoordRows: number;
}


