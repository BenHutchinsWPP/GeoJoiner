import type { LayerConfig, ManifestEntry } from "../geo/types";
import { BUILTIN_COLORS } from "../geo/layerConfig";

interface Props {
  manifest: ManifestEntry[];
  selectedLayers: LayerConfig[];
  onToggle: (entry: ManifestEntry, enabled: boolean) => void;
  onTogglePropertyKey: (id: string, propertyKey: string, enabled: boolean) => void;
}

export default function LayerSelector({
  manifest,
  selectedLayers,
  onToggle,
  onTogglePropertyKey,
}: Props) {
  const selectedIds = new Set(selectedLayers.map((l) => l.id));

  function getLayer(id: string): LayerConfig | undefined {
    return selectedLayers.find((l) => l.id === id);
  }

  return (
    <div className="layer-selector">
      <h2>3. Select Layers</h2>
      <p className="hint">Check the boundary layers to enrich with, then tick which values to output — each adds its own CSV column.</p>
      <div className="layer-list">
        {manifest.map((entry) => {
          const enabled = selectedIds.has(entry.id);
          const layer = getLayer(entry.id);
          const color = entry.color || BUILTIN_COLORS[entry.id] || "#888";

          return (
            <div key={entry.id} className={`layer-item ${enabled ? "enabled" : ""}`}>
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => onToggle(entry, e.target.checked)}
                />
                <span className="layer-color" style={{ backgroundColor: color }} />
                <span className="layer-label">{entry.label}</span>
              </label>

              {enabled && layer && layer.availableProperties.length > 1 && (
                <div className="layer-options">
                  <span className="layer-options-label">Output columns:</span>
                  {layer.availableProperties.map((p) => {
                    const checked = layer.propertyKeys.includes(p.key);
                    return (
                      <label key={p.key} className="property-toggle">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => onTogglePropertyKey(entry.id, p.key, e.target.checked)}
                        />
                        <span className="property-name">{p.label}</span>
                        {p.example && (
                          <span className="property-example">e.g. {p.example}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
