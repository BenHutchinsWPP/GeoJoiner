import type { CsvRow } from "../geo/types";

interface Props {
  rows: CsvRow[];
}

export default function ResultsPreview({ rows }: Props) {
  const displayRows = rows.slice(0, 50);

  if (displayRows.length === 0) {
    return <div className="results-preview"><p>No results yet.</p></div>;
  }

  const headers = Object.keys(displayRows[0]);

  return (
    <div className="results-preview">
      <h2>Preview ({rows.length} rows total)</h2>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i}>
                {headers.map((h) => (
                  <td key={h}>{row[h] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
