interface Props {
  headers: string[];
  latColumn: string;
  lonColumn: string;
  onLatChange: (col: string) => void;
  onLonChange: (col: string) => void;
}

export default function ColumnSelector({
  headers,
  latColumn,
  lonColumn,
  onLatChange,
  onLonChange,
}: Props) {
  return (
    <div className="column-selector">
      <h2>2. Select Columns</h2>
      <div className="select-row">
        <label>
          Latitude column:
          <select
            value={latColumn}
            onChange={(e) => onLatChange(e.target.value)}
          >
            <option value="">-- select --</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label>
          Longitude column:
          <select
            value={lonColumn}
            onChange={(e) => onLonChange(e.target.value)}
          >
            <option value="">-- select --</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
