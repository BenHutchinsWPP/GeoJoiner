function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * UTF-8 BOM. Excel opens a BOM-less CSV using the system ANSI codepage, which
 * renders accented names as mojibake ("Doña Ana" → "DoÃ±a Ana"). The BOM makes
 * it read UTF-8; other tools strip it as a no-op ZWNBSP.
 */
const UTF8_BOM = "﻿";

export function downloadText(text: string, filename: string, mime: string): void {
  const body = mime === "text/csv" && !text.startsWith(UTF8_BOM) ? UTF8_BOM + text : text;
  downloadBlob(new Blob([body], { type: `${mime};charset=utf-8` }), filename);
}
