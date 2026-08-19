import type { MatchStats } from "../geo/types";
import { DOWNLOAD_PHASE } from "../geo/types";

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

interface Props {
  phase: string;
  percent: number;
  processed: number;
  total: number;
  matchStats: MatchStats | null;
  onCancel: () => void;
}

export default function ProgressPanel({
  phase,
  percent,
  processed,
  total,
  matchStats,
  onCancel,
}: Props) {
  return (
    <div className="progress-panel">
      <h2>Processing</h2>
      <div className="progress-bar-container">
        <div
          className="progress-bar-fill"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <p className="progress-text">
        {phase === DOWNLOAD_PHASE
          ? `${phase}: ${mb(processed)} / ${mb(total)} MB (${percent}%)`
          : `${phase}: ${processed.toLocaleString()} / ${total.toLocaleString()} rows (${percent}%)`}
      </p>
      {matchStats && (
        <div className="match-stats">
          <span className="stat matched">✓ {matchStats.matchedRows.toLocaleString()} matched</span>
          <span className="stat unmatched">✗ {matchStats.unmatchedRows.toLocaleString()} unmatched</span>
          {matchStats.badCoordRows > 0 && (
            <span className="stat bad">⚠ {matchStats.badCoordRows.toLocaleString()} bad coords</span>
          )}
        </div>
      )}
      <button className="btn-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
