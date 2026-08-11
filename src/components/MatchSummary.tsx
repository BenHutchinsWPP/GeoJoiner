import type { MatchStats } from "../geo/types";

interface Props {
  stats: MatchStats;
}

export default function MatchSummary({ stats }: Props) {
  return (
    <div className="match-summary">
      <h2>Match Summary</h2>
      <div className="summary-grid">
        <div className="summary-card matched">
          <span className="summary-num">{stats.matchedRows.toLocaleString()}</span>
          <span className="summary-label">Matched</span>
        </div>
        <div className="summary-card unmatched">
          <span className="summary-num">{stats.unmatchedRows.toLocaleString()}</span>
          <span className="summary-label">Unmatched</span>
        </div>
        {stats.badCoordRows > 0 && (
          <div className="summary-card bad">
            <span className="summary-num">{stats.badCoordRows.toLocaleString()}</span>
            <span className="summary-label">Bad Coords</span>
          </div>
        )}
        <div className="summary-card total">
          <span className="summary-num">{stats.totalRows.toLocaleString()}</span>
          <span className="summary-label">Total Rows</span>
        </div>
      </div>
    </div>
  );
}
