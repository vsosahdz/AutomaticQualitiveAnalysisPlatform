// Pestaña "Cargar análisis": sube uno o varios JSON exportados por la herramienta
// y los muestra en el mismo visor que un análisis recién hecho.
import { useRef, useState } from "react";
import type { Code, CodedDocument, Result } from "../types";
import { parseAqaExport } from "../aqaFile";
import { ResultsView } from "./ResultsView";

/** Une los codebooks de los archivos cargados deduplicando por etiqueta. */
function mergeCodebooks(codebooks: Code[][]): Code[] {
  const byLabel = new Map<string, Code>();
  for (const cb of codebooks) {
    for (const c of cb) {
      if (!byLabel.has(c.label)) byLabel.set(c.label, c);
    }
  }
  return Array.from(byLabel.values());
}

export function LoadAnalysis() {
  const [documents, setDocuments] = useState<CodedDocument[]>([]);
  const [codebook, setCodebook] = useState<Code[]>([]);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  /** Lee los JSON seleccionados, valida la marca AQA y arma la vista. */
  async function ingest(files: FileList | null) {
    if (!files) return;
    setError(undefined);
    const docs: CodedDocument[] = [];
    const codebooks: Code[][] = [];
    const rejected: string[] = [];

    for (const file of Array.from(files)) {
      const text = await file.text();
      const parsed = parseAqaExport(text);
      if (!parsed) {
        rejected.push(file.name);
        continue;
      }
      docs.push(parsed.document);
      codebooks.push(parsed.codebook ?? []);
    }

    if (rejected.length > 0) {
      setError(
        `No son archivos de análisis válidos y se omitieron: ${rejected.join(", ")}`
      );
    }
    if (docs.length === 0) return;

    // Evita duplicados por nombre de documento (reemplaza el existente).
    const byName = new Map(documents.map((d) => [d.name, d]));
    for (const d of docs) byName.set(d.name, d);

    setDocuments(Array.from(byName.values()));
    setCodebook(mergeCodebooks([codebook, ...codebooks]));
  }

  const result: Result = { documents, dropped: [] };

  return (
    <div>
      <div className="panel">
        <h2>Cargar análisis</h2>
        <p className="hint">
          Sube uno o varios archivos <strong>*_AQA.json</strong> exportados por la
          herramienta para visualizarlos aquí.
        </p>
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            ingest(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <p>Arrastra archivos .json aquí o haz clic para seleccionar</p>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(e) => ingest(e.target.files)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        {documents.length > 0 && (
          <button
            className="button"
            onClick={() => {
              setDocuments([]);
              setCodebook([]);
            }}
          >
            Limpiar
          </button>
        )}
      </div>

      {documents.length > 0 && (
        <ResultsView result={result} codebook={codebook} />
      )}
    </div>
  );
}
