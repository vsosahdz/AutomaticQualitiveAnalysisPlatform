// Utilidades de descarga de archivos en el navegador.

/** Dispara la descarga de un Blob con el nombre indicado. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Descarga texto como archivo (UTF-8, con BOM opcional para CSV en Excel). */
export function downloadText(
  text: string,
  filename: string,
  mime = "text/plain",
  bom = false
): void {
  const content = bom ? "﻿" + text : text;
  downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
}

/** Convierte una matriz de celdas en una línea CSV (con escape). */
export function csvRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      const s = String(c ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
