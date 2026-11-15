// Vista de resultados reutilizable: pestañas por documento, visor con resaltado
// y edición de hallazgos, y descargas. Se usa tanto para un análisis recién hecho
// como para análisis cargados desde JSON. Las descargas (JSON y CSV) se generan
// en el navegador desde el estado actual, así que reflejan las ediciones.
import { useEffect, useMemo, useState } from "react";
import type { Code, Result } from "../types";
import type { EditableDocuments } from "../useEditableDocuments";
import { exportAllDocuments, exportDocument } from "../aqaFile";
import { csvOptions, downloadCsv, downloadCsvZip } from "../csvExport";
import { isEdited } from "../editing";
import { formatSeconds } from "../format";
import { HighlightViewer } from "./HighlightViewer";
import { useI18n } from "../i18n";

interface ResultsViewProps {
  /** Metadatos del análisis (tipo, modelos, tiempos, descartes). */
  result: Omit<Result, "documents">;
  /** Documentos editables del análisis. */
  editable: EditableDocuments;
  /** Codebook con el que se hizo el análisis (colores y etiquetas permitidas). */
  codebook: Code[];
}

export function ResultsView({ result, editable, codebook }: ResultsViewProps) {
  const { t } = useI18n();
  const [activeDoc, setActiveDoc] = useState(0);
  const docs = editable.docs;

  // Si cambia el conjunto de documentos, vuelve al primero.
  useEffect(() => {
    setActiveDoc(0);
  }, [docs.length]);

  // Etiquetas permitidas al editar: los códigos activos del análisis.
  const allowedLabels = useMemo(
    () => codebook.filter((c) => c.active !== false).map((c) => c.label),
    [codebook]
  );

  if (docs.length === 0) return null;
  const current = docs[Math.min(activeDoc, docs.length - 1)];
  const multiple = docs.length > 1;
  const options = csvOptions(result, docs);
  const editedCount = docs.filter(isEdited).length;

  return (
    <div className="panel">
      <div className="results-toolbar">
        {/* Grupo 1: elegir el documento que se visualiza (solo si hay varios). */}
        {multiple && (
          <div className="toolbar-group">
            <span className="group-label">{t("results.document")}</span>
            <div className="doc-tabs">
              {docs.map((d, i) => (
                <button
                  key={d.name}
                  className={i === activeDoc ? "active" : ""}
                  onClick={() => setActiveDoc(i)}
                >
                  {d.name}
                  {isEdited(d) && <span title={t("results.edited")}> ✎</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Grupo 2: exportar / descargar. */}
        <div className="toolbar-group exports">
          <span className="group-label">{t("results.export")}</span>

          <button
            className="button"
            onClick={() => {
              exportDocument(current, codebook);
              if (!multiple) editable.markClean();
            }}
            title={t("results.jsonTitle")}
          >
            {t("results.json", { name: current.name })}
          </button>

          {multiple && (
            <button
              className="button"
              onClick={async () => {
                await exportAllDocuments(docs, codebook);
                editable.markClean();
              }}
              title={t("results.allJsonTitle")}
            >
              {t("results.allJson")}
            </button>
          )}

          <button className="button" onClick={() => downloadCsv(docs, options)}>
            {multiple ? t("results.csvCombined") : t("results.csv")}
          </button>
          {multiple && (
            <button className="button" onClick={() => downloadCsvZip(docs, options)}>
              {t("results.csvZip")}
            </button>
          )}
        </div>
      </div>

      {/* Feedback de tiempos: total del trabajo y del documento actual. */}
      <p className="timing-note">
        {t("results.totalTime")} <strong>{formatSeconds(result.total_seconds)}</strong>
        {multiple && current.elapsed_seconds !== undefined && (
          <>
            {" · "}{t("results.thisDoc")}{" "}
            <strong>{formatSeconds(current.elapsed_seconds)}</strong>
          </>
        )}
        {result.dropped.length > 0 && (
          <span className="dropped-note">
            {" · "}
            {t("results.dropped", { n: result.dropped.length })}
          </span>
        )}
        {editedCount > 0 && (
          <span className={editable.dirty ? "dirty-note" : "meta"}>
            {" · "}
            {t("results.editedDocs", { n: editedCount })}
            {editable.dirty && t("results.unsaved")}
          </span>
        )}
      </p>

      <HighlightViewer
        doc={current}
        codebook={codebook}
        ensembleModels={
          result.analysis_type === "consensus" ? result.models : undefined
        }
        editing={{
          allowedLabels,
          apply: (op) => editable.apply(current.name, op),
          undo: () => editable.undo(current.name),
          canUndo: editable.canUndo(current.name),
        }}
      />
    </div>
  );
}
