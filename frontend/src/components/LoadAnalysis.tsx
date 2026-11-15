// Pestaña "Cargar análisis": sube uno o varios JSON exportados por la herramienta
// y los muestra en el mismo visor que un análisis recién hecho, donde también
// pueden editarse.
import { useRef, useState } from "react";
import type { Code, CodedDocument } from "../types";
import { parseAqaExport } from "../aqaFile";
import { useEditableDocuments } from "../useEditableDocuments";
import { ResultsView } from "./ResultsView";
import { useI18n } from "../i18n";

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
  const editable = useEditableDocuments();
  const { lang, t } = useI18n();
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
      setError(t("load.invalid", { files: rejected.join(", ") }));
    }
    if (docs.length === 0) return;

    // Evita duplicados por nombre de documento (reemplaza el existente).
    const replaced = docs.filter((d) => editable.docs.some((e) => e.name === d.name));
    if (
      replaced.length > 0 &&
      editable.dirty &&
      !window.confirm(t("load.confirmReplace", { files: replaced.map((d) => d.name).join(", ") }))
    ) {
      return;
    }
    editable.upsert(docs);
    setCodebook(mergeCodebooks([codebook, ...codebooks]));
  }

  return (
    <div>
      <div className="panel">
        <h2>{t("load.title")}</h2>
        {lang === "es" ? (
          <p className="hint">
            Sube uno o varios archivos <strong>*_AQA.json</strong> exportados por la
            herramienta para visualizarlos aquí.
          </p>
        ) : (
          <p className="hint">
            Upload one or more <strong>*_AQA.json</strong> files exported by the tool
            to view them here.
          </p>
        )}
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            ingest(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <p>{t("load.drop")}</p>
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
        {editable.docs.length > 0 && (
          <button
            className="button"
            onClick={() => {
              if (
                editable.dirty &&
                !window.confirm(t("load.confirmClear"))
              ) {
                return;
              }
              editable.setAll([]);
              setCodebook([]);
            }}
          >
            {t("load.clear")}
          </button>
        )}
      </div>

      {editable.docs.length > 0 && (
        <ResultsView result={{ dropped: [] }} editable={editable} codebook={codebook} />
      )}
    </div>
  );
}
