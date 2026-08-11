function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLon(lon: number): boolean {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

export function isValidCoord(lat: number, lon: number): boolean {
  return isValidLat(lat) && isValidLon(lon);
}

export function detectLatLonColumns(
  headers: string[],
): { lat: string; lon: string } {
  let latCol = "";
  let lonCol = "";

  for (const h of headers) {
    const hl = h.toLowerCase();
    if (/^lat/i.test(hl)) latCol = h;
    else if (/^(lon|lng|long)/i.test(hl)) lonCol = h;
  }

  if (!latCol) latCol = headers[0] || "";
  if (!lonCol) lonCol = headers[1] || "";

  return { lat: latCol, lon: lonCol };
}

export function warnFileSize(bytes: number): string | null {
  const mb = bytes / (1024 * 1024);
  if (mb > 100) return `File is ${mb.toFixed(1)}MB — may cause memory issues.`;
  if (mb > 50) return `File is ${mb.toFixed(1)}MB — consider using a smaller file.`;
  return null;
}
