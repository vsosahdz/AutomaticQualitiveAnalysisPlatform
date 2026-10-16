// Vista de resultados reutilizable: pestañas por documento, visor con resaltado,
// y descargas. Se usa tanto para un análisis recién hecho (con jobId → permite
// descargar CSV del backend) como para análisis cargados desde JSON (sin jobId).
import { useEffect, useState } from "react";
import type { Code, Result } from "../types";
import { csvUrl, csvZipUrl } from "../api";
import { exportAllDocuments, exportDocument } from "../aqaFile";
import { formatSeconds } from "../format";
import { HighlightViewer } from "./HighlightViewer";

interface ResultsViewProps {
  result: Result;
  codebook: Code[];
  /** ID del trabajo; si está presente habilita las descargas de CSV del backend. */
  jobId?: string | null;
}

export function ResultsView({ result, codebook, jobId }: ResultsViewProps) {
  const [activeDoc, setActiveDoc] = useState(0);
  const docs = result.documents;

  // Si cambia el conjunto de documentos, vuelve al primero.
  useEffect(() => {
    setActiveDoc(0);
  }, [docs.length]);

  if (docs.length === 0) return null;
  const current = docs[Math.min(activeDoc, docs.length - 1)];
  const multiple = docs.length > 1;

  return (
    <div className="panel">
      <div className="results-toolbar">
        {/* Grupo 1: elegir el documento que se visualiza (solo si hay varios). */}
        {multiple && (
          <div className="toolbar-group">
            <span className="group-label">Documento:</span>
            <div className="doc-tabs">
              {docs.map((d, i) => (
                <button
                  key={d.name}
                  className={i === activeDoc ? "active" : ""}
                  onClick={() => setActiveDoc(i)}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Grupo 2: exportar / descargar. */}
        <div className="toolbar-group exports">
          <span className="group-label">Exportar:</span>

          <button
            className="button"
            onClick={() => exportDocument(current, codebook)}
            title="Exporta este documento a un JSON reutilizable"
          >
            ⬇ JSON ({current.name})
          </button>

          {multiple && (
            <button
              className="button"
              onClick={() => exportAllDocuments(docs, codebook)}
              title="Exporta todos los documentos como un ZIP de JSON"
            >
              ⬇ Todos (JSON .zip)
            </button>
          )}

          {jobId && !multiple && (
            <a className="button" href={csvUrl(jobId)}>
              ↓ CSV
            </a>
          )}
          {jobId && multiple && (
            <>
              <a className="button" href={csvUrl(jobId)}>
                ↓ CSV combinado
              </a>
              <a className="button" href={csvZipUrl(jobId)}>
                ↓ CSV separados (.zip)
              </a>
            </>
          )}
        </div>
      </div>

      {/* Feedback de tiempos: total del trabajo y del documento actual. */}
      <p className="timing-note">
        ⏱ Tiempo total: <strong>{formatSeconds(result.total_seconds)}</strong>
        {multiple && current.elapsed_seconds !== undefined && (
          <>
            {" · "}este documento:{" "}
            <strong>{formatSeconds(current.elapsed_seconds)}</strong>
          </>
        )}
        {result.dropped.length > 0 && (
          <span className="dropped-note">
            {" · "}
            {result.dropped.length} salida(s) del LLM descartada(s)
          </span>
        )}
      </p>

      <HighlightViewer
        doc={current}
        codebook={codebook}
        ensembleModels={
          result.analysis_type === "consensus" ? result.models : undefined
        }
      />
    </div>
  );
}
