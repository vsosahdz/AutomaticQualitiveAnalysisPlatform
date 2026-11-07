// Formato de exportación/importación de un análisis por archivo.
//
// Cada documento analizado puede exportarse a un JSON que incluye una marca
// (`aqa`) para identificar que lo generó esta herramienta, el documento con sus
// fragmentos y el codebook usado (para reproducir los colores al recargarlo).
import JSZip from "jszip";
import type { Code, CodedDocument } from "./types";

/** Marca que identifica un archivo exportado por la herramienta. */
export const AQA_KIND = "aqa-analysis-export";
const AQA_VERSION = "0.1.0";
const AQA_TOOL = "Análisis Cualitativo Automático";

/** Estructura de un archivo de análisis exportado. */
export interface AqaExport {
  /** Atributo-marca que identifica el origen del archivo. */
  aqa: { tool: string; version: string; kind: string };
  document: CodedDocument;
  codebook: Code[];
}

/** Quita la extensión de un nombre de archivo ("e_01.txt" -> "e_01"). */
export function baseName(name: string): string {
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

/** Dispara la descarga de un Blob con el nombre indicado. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Construye el objeto exportable (con marca) de un documento. */
function buildExport(doc: CodedDocument, codebook: Code[]): AqaExport {
  return {
    aqa: { tool: AQA_TOOL, version: AQA_VERSION, kind: AQA_KIND },
    document: doc,
    codebook,
  };
}

/** Nombre de archivo JSON para un documento: ``<base>_AQA.json``. */
function jsonFileName(doc: CodedDocument): string {
  return `${baseName(doc.name)}_AQA.json`;
}

/**
 * Exporta un documento analizado a un JSON descargable.
 * Nombre por defecto: ``<nombre_sin_extensión>_AQA.json``.
 */
export function exportDocument(doc: CodedDocument, codebook: Code[]): void {
  const blob = new Blob([JSON.stringify(buildExport(doc, codebook), null, 2)], {
    type: "application/json",
  });
  download(blob, jsonFileName(doc));
}

/**
 * Exporta todos los documentos a un ZIP con un JSON por documento.
 * Cada entrada usa el mismo formato que :func:`exportDocument`.
 */
export async function exportAllDocuments(
  docs: CodedDocument[],
  codebook: Code[]
): Promise<void> {
  const zip = new JSZip();
  for (const doc of docs) {
    zip.file(
      jsonFileName(doc),
      JSON.stringify(buildExport(doc, codebook), null, 2)
    );
  }
  const blob = await zip.generateAsync({ type: "blob" });
  download(blob, "analisis_AQA.zip");
}

/**
 * Interpreta el texto de un archivo como un análisis exportado por la herramienta.
 * @returns el objeto :class:`AqaExport` si es válido, o ``null`` si no lo es.
 */
export function parseAqaExport(text: string): AqaExport | null {
  try {
    const data = JSON.parse(text);
    if (
      data &&
      typeof data === "object" &&
      data.aqa?.kind === AQA_KIND &&
      data.document &&
      Array.isArray(data.document.fragments)
    ) {
      return data as AqaExport;
    }
  } catch {
    // No es JSON válido.
  }
  return null;
}
