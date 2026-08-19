import { useGeoJoin } from "./hooks/useGeoJoin";
import { downloadText } from "./utils/download";
import CsvUpload from "./components/CsvUpload";
import ColumnSelector from "./components/ColumnSelector";
import LayerSelector from "./components/LayerSelector";
import GeoJsonUpload from "./components/GeoJsonUpload";
import ProgressPanel from "./components/ProgressPanel";
import ResultsPreview from "./components/ResultsPreview";
import MatchSummary from "./components/MatchSummary";
import ErrorBanner from "./components/ErrorBanner";
import MapPanel from "./components/MapPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function App() {
  const {
    csvHeaders, latColumn, lonColumn, setLatColumn, setLonColumn,
    manifest, selectedLayers, uploadedLayers,
    running, phase, percent, processed, total, matchStats, previewRows, result,
    mapPoints, mapLayers,
    errors, setErrors,
    matchMode, setMatchMode,
    handleCsvLoaded, handleLayerToggle, togglePropertyKey,
    handleGeoJsonAdd, handleGeoJsonRemove,
    handleRun, handleCancel, handleDownload,
    canRun,
  } = useGeoJoin();

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-row">
          <img
            src={`${import.meta.env.BASE_URL}WPP-Logo-Circle.png`}
            className={`wpp-logo${running ? " spinning" : ""}`}
            alt="WPP"
          />
          <h1>GeoJoiner</h1>
        </div>
        <p className="subtitle">Browser-based point-in-polygon enrichment. No server. No upload.</p>
      </header>

      <ErrorBanner errors={errors} onDismiss={() => setErrors([])} />

      <div className="app-layout">
        <div className="app-main">
          <CsvUpload onCsvLoaded={handleCsvLoaded} />

          {csvHeaders.length > 0 && (
            <ColumnSelector
              headers={csvHeaders}
              latColumn={latColumn}
              lonColumn={lonColumn}
              onLatChange={setLatColumn}
              onLonChange={setLonColumn}
            />
          )}

          <LayerSelector
            manifest={manifest}
            selectedLayers={selectedLayers}
            onToggle={handleLayerToggle}
            onTogglePropertyKey={togglePropertyKey}
          />

          <GeoJsonUpload
            layers={uploadedLayers}
            onAdd={handleGeoJsonAdd}
            onRemove={handleGeoJsonRemove}
            onTogglePropertyKey={togglePropertyKey}
          />

          <div className="match-mode-row">
            <label>
              When a point matches multiple polygons:
              <select value={matchMode} onChange={(e) => setMatchMode(e.target.value as typeof matchMode)}>
                <option value="first">Keep first match</option>
                <option value="join">Join all with ";"</option>
                <option value="all">JSON array of all</option>
              </select>
            </label>
          </div>

          <div className="action-row">
            <button className="btn-run" onClick={handleRun} disabled={!canRun || running}>
              {running ? "Processing..." : "Run GeoJoin"}
            </button>
          </div>

          {running && (
            <ProgressPanel
              phase={phase}
              percent={percent}
              processed={processed}
              total={total}
              matchStats={matchStats}
              onCancel={handleCancel}
            />
          )}

          {result && !running && (
            <>
              <MatchSummary stats={result.matchStats} />
              <div className="action-row">
                <button className="btn-download" onClick={handleDownload}>Download CSV</button>
              </div>

              {manifest.filter(m => m.translationUrl).length > 0 && (
                <div className="translation-section">
                  <h3>Download Translations</h3>
                  <div className="translation-buttons">
                    {manifest.filter(m => m.translationUrl).map(entry => (
                      <button
                        key={entry.id}
                        className="btn-translation"
                        onClick={async () => {
                          try {
                            const res = await fetch(entry.translationUrl!);
                            const csv = await res.text();
                            downloadText(csv, `${entry.id}-translations.csv`, "text/csv");
                          } catch { /* fail silently */ }
                        }}
                      >
                        {entry.translatedFrom || entry.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <ResultsPreview rows={previewRows} />
            </>
          )}

          {(mapPoints.length > 0 || mapLayers.length > 0) && (
            <ErrorBoundary>
              <MapPanel points={mapPoints} layers={mapLayers} height="400px" />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
