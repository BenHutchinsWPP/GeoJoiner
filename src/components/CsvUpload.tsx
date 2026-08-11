import { useRef, useState } from "react";
import { warnFileSize } from "../geo/validation";
import { useDragDrop } from "../hooks/useDragDrop";

interface Props {
  onCsvLoaded: (text: string, headers: string[]) => void;
}

export default function CsvUpload({ onCsvLoaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const { dragOver, dropProps } = useDragDrop(handleFile);

  function handleFile(file: File) {
    setWarning(null);
    const w = warnFileSize(file.size);
    if (w) setWarning(w);

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        setWarning("CSV file appears empty.");
        return;
      }
      const headers = lines[0].split(",").map((h) => h.trim());
      onCsvLoaded(text, headers);
    };
    reader.onerror = () => setWarning("Failed to read file.");
    reader.readAsText(file);
  }

  return (
    <div
      className={`csv-upload ${dragOver ? "drag-over" : ""}`}
      {...dropProps}
    >
      <h2>1. Upload CSV</h2>
      <p className="hint">Drag & drop or click to browse. Must have lat/lon columns.</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <button onClick={() => inputRef.current?.click()}>
        {dragOver ? "Drop file here" : "Choose CSV file"}
      </button>
      <button
        className="btn-sample"
        onClick={() => {
          const sample = "id,lat,lon,city\n1,40.7128,-74.0060,New York NY\n2,34.0522,-118.2437,Los Angeles CA\n3,41.8781,-87.6298,Chicago IL\n4,29.7604,-95.3698,Houston TX\n5,33.4484,-112.0740,Phoenix AZ\n6,39.9526,-75.1652,Philadelphia PA\n7,29.4241,-98.4936,San Antonio TX\n8,32.7157,-117.1611,San Diego CA\n9,32.7767,-96.7970,Dallas TX\n10,25.7617,-80.1918,Miami FL\n11,33.7490,-84.3880,Atlanta GA\n12,38.9072,-77.0369,Washington DC\n13,42.3601,-71.0589,Boston MA\n14,39.7392,-104.9903,Denver CO\n15,47.6062,-122.3321,Seattle WA\n16,36.1627,-86.7816,Nashville TN\n17,45.5152,-122.6784,Portland OR\n18,36.1699,-115.1398,Las Vegas NV\n19,44.9778,-93.2650,Minneapolis MN\n20,42.3314,-83.0458,Detroit MI";
          onCsvLoaded(sample, ["id", "lat", "lon", "city"]);
        }}
      >
        Use sample data
      </button>
      {warning && <p className="warning">{warning}</p>}
    </div>
  );
}
