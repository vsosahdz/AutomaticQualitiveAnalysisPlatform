// CSV del resultado generado en el navegador a partir de los documentos en su
// estado actual (incluidas las ediciones). Replica las reglas de
// backend/app/services/csv_export.py: columnas `archivo, cita, codigo,
// justificacion`, `acuerdo` ("k de n") en consenso y `origen` si hubo ediciones;
// UTF-8 con BOM; un ZIP con un CSV por documento.
import JSZip from "jszip";
import type { CodedDocument, Result } from "./types";
import { isEdited, originOf } from "./editing";
import { baseName } from "./aqaFile";
import { downloadBlob } from "./download";

const BASE_HEADERS = ["archivo", "cita", "codigo", "justificacion"];
const BOM = "﻿";
// Mismo terminador de línea que el módulo csv de Python.
const EOL = "\r\n";

/** Celda CSV con el mismo criterio de comillas que csv.QUOTE_MINIMAL de Python. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function row(cells: string[]): string {
  return cells.map(cell).join(",") + EOL;
}

interface CsvOptions {
  /** Número de modelos del ensamble (0 si no es consenso). */
  totalModels: number;
  /** Incluir la columna `origen`. */
  withOrigin: boolean;
}

/** Opciones del CSV para un resultado: consenso y ediciones de cualquier documento. */
export function csvOptions(result: Pick<Result, "analysis_type" | "models">, docs: CodedDocument[]): CsvOptions {
  return {
    totalModels: result.analysis_type === "consensus" ? result.models?.length ?? 0 : 0,
    withOrigin: docs.some(isEdited),
  };
}

function headers({ totalModels, withOrigin }: CsvOptions): string[] {
  return [
    ...BASE_HEADERS,
    ...(totalModels ? ["acuerdo"] : []),
    ...(withOrigin ? ["origen"] : []),
  ];
}

function documentRows(doc: CodedDocument, { totalModels, withOrigin }: CsvOptions): string {
  let out = "";
  for (const f of doc.fragments) {
    const cells = [doc.name, f.quote, f.code, f.justification];
    if (totalModels) {
      // Un hallazgo manual no pasó por los modelos: acuerdo vacío.
      cells.push(originOf(f) === "manual" ? "" : `${f.models?.length ?? 0} de ${totalModels}`);
    }
    if (withOrigin) cells.push(originOf(f));
    out += row(cells);
  }
  return out;
}

/** CSV combinado (sin BOM) de varios documentos. */
export function documentsToCsv(docs: CodedDocument[], options: CsvOptions): string {
  return row(headers(options)) + docs.map((d) => documentRows(d, options)).join("");
}

/** Descarga el CSV combinado de los documentos. */
export function downloadCsv(docs: CodedDocument[], options: CsvOptions): void {
  const blob = new Blob([BOM + documentsToCsv(docs, options)], { type: "text/csv;charset=utf-8" });
  const name = docs.length === 1 ? `${baseName(docs[0].name)}.csv` : "analisis_AQA.csv";
  downloadBlob(blob, name);
}

/** Descarga un ZIP con un CSV (con BOM) por documento. */
export async function downloadCsvZip(docs: CodedDocument[], options: CsvOptions): Promise<void> {
  const zip = new JSZip();
  for (const d of docs) {
    zip.file(`${baseName(d.name)}.csv`, BOM + documentsToCsv([d], options));
  }
  downloadBlob(await zip.generateAsync({ type: "blob" }), "analisis_AQA_csv.zip");
}
