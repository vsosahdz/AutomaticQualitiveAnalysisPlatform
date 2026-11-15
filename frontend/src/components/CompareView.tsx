// Pestaña "Comparar". Dos modos:
// - "Humano vs LLM" (Fase II): carga la codificación del LLM (JSON exportado) y
//   la humana (CSV/XLSX), ejecuta POST /compare y muestra métricas léxicas,
//   hallazgos semánticos (solo-IA por novedad, solo-humano) con su cita más
//   parecida del otro lado, permite marcar la relevancia de los hallazgos solo-IA
//   y exportar el reporte (JSON/CSV/DOCX). Incluye un diff por oración.
// - "A vs B": compara dos codificaciones cualesquiera (ver PairCompareView).
import { useMemo, useRef, useState } from "react";
import type {
  Code,
  CodedDocument,
  ComparisonResult,
  DocumentComparison,
  FragmentSim,
  HumanSummary,
  UnitDiff,
} from "../types";
import { ApiError, compareCodings, humanSummary, reportDocx } from "../api";
import { AQA_TOOL, AQA_VERSION, parseAqaExport } from "../aqaFile";
import { csvRow, downloadBlob, downloadText } from "../download";
import {
  belowThreshold,
  contextAround,
  countByCode,
  CountsTable,
  DiffView,
  FindingItem,
  ThresholdControl,
  type DiffStatus,
} from "./compareParts";
import { PairCompareView } from "./PairCompareView";
import { useI18n, type MessageKey } from "../i18n";

/** Estados del diff humano vs LLM con la clave de su etiqueta y su color. */
const DIFF_STATUSES: Array<[string, MessageKey, string]> = [
  ["agree", "diff.agree", "#2E933C"],
  ["only_llm", "diff.onlyLlm", "#3A6EA5"],
  ["only_human", "diff.onlyHuman", "#E4572E"],
  ["partial", "diff.partial", "#C9A227"],
];

/** Marca que identifica un archivo de comparación guardado por la herramienta. */
const AQA_COMPARISON_KIND = "aqa-comparison-export";

/** Relevancia marcada por la persona para un hallazgo solo-IA. */
type Relevance = "relevant" | "no";

/** Clave estable de un hallazgo (documento + span + código). */
function findingKey(docName: string, f: FragmentSim): string {
  return `${docName}|${f.start}-${f.end}|${f.code}`;
}

/** Cuenta las oraciones por estado de acuerdo del diff. */
function countStatuses(units: UnitDiff[]) {
  const c = { agree: 0, only_llm: 0, only_human: 0, partial: 0 };
  for (const u of units) {
    if (u.status in c) c[u.status as keyof typeof c]++;
  }
  return c;
}

type CompareMode = "human-llm" | "ab";

export function CompareView() {
  const [mode, setMode] = useState<CompareMode>("human-llm");
  const { t } = useI18n();
  return (
    <div>
      <div className="panel compare-mode">
        <span className="group-label">{t("compare.mode")}</span>
        <label>
          <input
            type="radio"
            name="compare-mode"
            checked={mode === "human-llm"}
            onChange={() => setMode("human-llm")}
          />
          {t("compare.modeHumanLlm")}
        </label>
        <label>
          <input
            type="radio"
            name="compare-mode"
            checked={mode === "ab"}
            onChange={() => setMode("ab")}
          />
          {t("compare.modeAb")}
        </label>
      </div>
      {/* Ambos modos quedan montados para conservar su estado. */}
      <div hidden={mode !== "human-llm"}>
        <HumanLlmCompare />
      </div>
      <div hidden={mode !== "ab"}>
        <PairCompareView />
      </div>
    </div>
  );
}

function HumanLlmCompare() {
  const { lang, t } = useI18n();
  const [llmDocs, setLlmDocs] = useState<CodedDocument[]>([]);
  const [llmCodebook, setLlmCodebook] = useState<Code[]>([]);
  const [humanFile, setHumanFile] = useState<File | null>(null);
  const [humanCounts, setHumanCounts] = useState<HumanSummary | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [threshold, setThreshold] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [activeDoc, setActiveDoc] = useState(0);
  // Relevancia marcada por la persona, por clave de hallazgo.
  const [relevance, setRelevance] = useState<Record<string, Relevance>>({});
  const llmInput = useRef<HTMLInputElement>(null);

  /** Carga uno o varios JSON exportados por la herramienta como codificación LLM. */
  async function loadLlm(files: FileList | null) {
    if (!files) return;
    const docs: CodedDocument[] = [];
    const codebook = new Map<string, Code>();
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      const parsed = parseAqaExport(await f.text());
      if (parsed) {
        docs.push(parsed.document);
        // Une los codebooks de los archivos (dedup por etiqueta) para las definiciones.
        for (const c of parsed.codebook ?? []) if (!codebook.has(c.label)) codebook.set(c.label, c);
      } else bad.push(f.name);
    }
    setError(bad.length ? t("hl.invalidJson", { files: bad.join(", ") }) : undefined);
    if (docs.length) {
      setLlmDocs(docs);
      setLlmCodebook(Array.from(codebook.values()));
    }
  }

  /** Al elegir el archivo humano, lo guarda y cuantifica sus citas por código. */
  async function onHumanFile(file: File | null) {
    setHumanFile(file);
    setHumanCounts(null);
    if (!file) return;
    try {
      setHumanCounts(await humanSummary(file));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hl.humanReadError"));
    }
  }

  // Conteo de citas del LLM por código (a partir de los documentos cargados).
  const llmCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of llmDocs) for (const f of d.fragments) c[f.code] = (c[f.code] ?? 0) + 1;
    return c;
  }, [llmDocs]);

  // Datos de la comparativa de conteos: prioriza lo subido y, si no, lo deriva
  // del resultado de la comparación (que ya contiene ambos lados).
  const countsData = useMemo(() => {
    const humanByCode =
      humanCounts?.by_code ??
      countByCode(result?.documents.flatMap((d) => d.human_fragments) ?? []);
    const humanTotal =
      humanCounts?.total ?? Object.values(humanByCode).reduce((a, b) => a + b, 0);
    const humanDocs = humanCounts?.documents ?? result?.documents.map((d) => d.name) ?? [];
    const hasLlmDocs = llmDocs.length > 0;
    const llmByCode = hasLlmDocs
      ? llmCounts
      : countByCode(result?.documents.flatMap((d) => d.llm_fragments) ?? []);
    const hasLlm =
      hasLlmDocs || (result?.documents.some((d) => d.llm_fragments.length > 0) ?? false);
    return {
      show: !!humanCounts || !!result,
      human: { by_code: humanByCode, total: humanTotal, documents: humanDocs } as HumanSummary,
      llm: llmByCode,
      hasLlm,
    };
  }, [humanCounts, llmCounts, llmDocs, result]);

  /** Ejecuta la comparación. */
  async function runCompare() {
    if (!humanFile || llmDocs.length === 0) return;
    setBusy(true);
    setError(undefined);
    setResult(null);
    setRelevance({});
    try {
      const res = await compareCodings(llmDocs, humanFile);
      setResult(res);
      setThreshold(res.default_threshold);
      setActiveDoc(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("compare.error"));
    } finally {
      setBusy(false);
    }
  }

  /** Marca/alterna la relevancia de un hallazgo solo-IA. */
  function markRelevance(docName: string, f: FragmentSim, value: Relevance) {
    const key = findingKey(docName, f);
    setRelevance((prev) => {
      const next = { ...prev };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  /** Guarda la comparación COMPLETA (recargable): resultado + umbral + relevancia. */
  function saveComparison() {
    if (!result) return;
    const payload = {
      aqa: { tool: AQA_TOOL, version: AQA_VERSION, kind: AQA_COMPARISON_KIND },
      threshold,
      relevance,
      result,
    };
    downloadText(
      JSON.stringify(payload, null, 2),
      "comparacion_AQA.json",
      "application/json"
    );
  }

  /** Carga una comparación previamente guardada y la muestra sin recomputar. */
  async function loadComparison(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(undefined);
    try {
      const data = JSON.parse(await files[0].text());
      if (data?.aqa?.kind !== AQA_COMPARISON_KIND || !data.result) {
        setError(t("hl.invalidSaved"));
        return;
      }
      setResult(data.result as ComparisonResult);
      setThreshold(typeof data.threshold === "number" ? data.threshold : 0.7);
      setRelevance(data.relevance ?? {});
      setActiveDoc(0);
    } catch {
      setError(t("compare.readError"));
    }
  }

  /** Exporta los hallazgos a CSV (una fila por hallazgo). */
  function exportCsv() {
    if (!result) return;
    const header = [
      "tipo", "documento", "codigo", "cita", "similitud",
      "cita_mas_parecida", "codigo_parecido", "relevancia", "nota",
    ];
    const lines = [csvRow(header)];
    for (const d of result.documents) {
      for (const f of d.llm_fragments) {
        const tipo = f.max_similarity < threshold ? "solo-IA" : "acuerdo-IA";
        const rel = f.max_similarity < threshold ? relevance[findingKey(d.name, f)] ?? "" : "";
        lines.push(csvRow([tipo, d.name, f.code, f.quote, f.max_similarity,
          f.best_match_quote, f.best_match_code, rel, f.justification]));
      }
      for (const f of d.human_fragments.filter((x) => x.max_similarity < threshold)) {
        lines.push(csvRow(["solo-humano", d.name, f.code, f.quote, f.max_similarity,
          f.best_match_quote, f.best_match_code, "", f.comment]));
      }
    }
    downloadText(lines.join("\n"), "comparacion_hallazgos.csv", "text/csv", true);
  }

  /** Genera y descarga el reporte DOCX de hallazgos solo-IA. */
  async function exportDocx() {
    if (!result) return;
    // Definiciones (etiqueta → definición) una sola vez, desde el codebook del LLM.
    const definitions: Record<string, string> = {};
    for (const c of llmCodebook) if (c.definition) definitions[c.label] = c.definition;
    const payload = {
      embedding_model: result.embedding_model,
      threshold,
      definitions,
      documents: result.documents.map((d) => ({
        name: d.name,
        overall: d.overall,
        per_code: d.per_code,
        diff_counts: countStatuses(d.units),
        only_ai: d.llm_fragments
          .filter((f) => f.max_similarity < threshold)
          .sort((a, b) => a.max_similarity - b.max_similarity)
          .map((f) => ({
            code: f.code,
            quote: f.quote,
            justification: f.justification,
            max_similarity: f.max_similarity,
            best_match_quote: f.best_match_quote,
            best_match_code: f.best_match_code,
            relevancia: relevance[findingKey(d.name, f)] ?? "",
            // Contexto del documento con la cita marcada (se pone en negritas en el DOCX).
            context: contextAround(d.full_text, f.start, f.end),
          })),
      })),
    };
    try {
      const blob = await reportDocx(payload);
      downloadBlob(blob, "hallazgos_IA_AQA.docx");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hl.docxError"));
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>{t("hl.title")}</h2>
        {lang === "es" ? (
          <p className="hint">
            Carga la codificación del <strong>LLM</strong> (JSON exportado por la
            herramienta) y la codificación <strong>humana</strong> (CSV o XLSX con
            columnas <em>document, quotation, codes, comment</em>) del mismo documento.
          </p>
        ) : (
          <p className="hint">
            Load the <strong>LLM</strong> coding (JSON exported by the tool) and the{" "}
            <strong>human</strong> coding (CSV or XLSX with the columns{" "}
            <em>document, quotation, codes, comment</em>) of the same document.
          </p>
        )}

        <div className="compare-inputs">
          <div>
            <button className="button" onClick={() => llmInput.current?.click()}>
              {t("hl.loadLlm")}
            </button>
            <input
              ref={llmInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(e) => loadLlm(e.target.files)}
            />
            <span className="meta">
              {llmDocs.length > 0 ? t("common.docs", { n: llmDocs.length }) : t("common.none")}
            </span>
          </div>

          <div>
            <label className="button">
              {t("hl.loadHuman")}
              <input
                type="file"
                accept=".csv,.xlsx"
                hidden
                onChange={(e) => onHumanFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="meta">{humanFile ? ` ${humanFile.name}` : t("common.none")}</span>
          </div>

          <button
            className="primary big"
            disabled={busy || llmDocs.length === 0 || !humanFile}
            onClick={runCompare}
          >
            {busy ? t("compare.comparing") : t("compare.run")}
          </button>

          <div className="compare-load">
            <span className="meta">{t("hl.orLoad")}</span>
            <label className="button">
              {t("compare.loadSaved")}
              <input
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => loadComparison(e.target.files)}
              />
            </label>
          </div>
        </div>

        {error && <p className="error">{error}</p>}
        {result && result.unmapped.length > 0 && (
          <p className="dropped-note">
            {t("hl.unmapped", { n: result.unmapped.length })}
          </p>
        )}
        {result && (
          <div className="result-actions">
            <button className="button" onClick={exportDocx}>{t("hl.docx")}</button>
            <button className="button" onClick={saveComparison}>{t("compare.save")}</button>
            <button className="button" onClick={exportCsv}>{t("compare.csv")}</button>
          </div>
        )}
      </div>

      {/* Conteo de citas por código (humano vs LLM). Aparece al subir el archivo
          humano y, tras comparar, se deriva también del resultado. */}
      {countsData.show && (
        <CountsPanel human={countsData.human} llm={countsData.llm} hasLlm={countsData.hasLlm} />
      )}

      {result && result.documents.length > 0 && (
        <div className="panel">
          {result.documents.length > 1 && (
            <div className="doc-tabs">
              {result.documents.map((d, i) => (
                <button
                  key={d.name}
                  className={i === activeDoc ? "active" : ""}
                  onClick={() => setActiveDoc(i)}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}
          <ComparisonReport
            doc={result.documents[Math.min(activeDoc, result.documents.length - 1)]}
            threshold={threshold}
            onThreshold={setThreshold}
            embeddingModel={result.embedding_model}
            relevance={relevance}
            onMark={markRelevance}
          />
        </div>
      )}
    </div>
  );
}

interface CountsPanelProps {
  human: HumanSummary;
  llm: Record<string, number>;
  hasLlm: boolean;
}

/** Panel con el conteo de citas por código (humano vs LLM), resaltando los 3 de interés. */
function CountsPanel({ human, llm, hasLlm }: CountsPanelProps) {
  const { lang, t } = useI18n();
  const docs = human.documents.length;
  return (
    <div className="panel">
      <h3>{t("compare.countsTitle")}</h3>
      {lang === "es" ? (
        <p className="meta">
          Codificación humana: <strong>{human.total}</strong> citas
          {docs > 0 && ` · ${docs} documento(s)`}
          {hasLlm && " · comparado con las citas del/los LLM cargados"}.
        </p>
      ) : (
        <p className="meta">
          Human coding: <strong>{human.total}</strong> quotations
          {docs > 0 && ` · ${docs} document(s)`}
          {hasLlm && " · compared with the quotations of the loaded LLM coding(s)"}.
        </p>
      )}
      <CountsTable
        leftLabel={t("hl.human")}
        left={human.by_code}
        rightLabel={hasLlm ? "LLM" : undefined}
        right={hasLlm ? llm : undefined}
      />
      {!hasLlm && (
        <p className="meta">{t("hl.loadLlmForCounts")}</p>
      )}
    </div>
  );
}

interface ReportProps {
  doc: DocumentComparison;
  threshold: number;
  onThreshold: (v: number) => void;
  embeddingModel: string;
  relevance: Record<string, Relevance>;
  onMark: (docName: string, f: FragmentSim, value: Relevance) => void;
}

/** Reporte de un documento: métricas, hallazgos (con relevancia) y diff. */
function ComparisonReport({
  doc, threshold, onThreshold, embeddingModel, relevance, onMark,
}: ReportProps) {
  const onlyAi = useMemo(() => belowThreshold(doc.llm_fragments, threshold), [doc, threshold]);
  const onlyHuman = useMemo(
    () => belowThreshold(doc.human_fragments, threshold),
    [doc, threshold]
  );
  const diffUnits = useMemo(
    () => doc.units.map((u) => ({ text: u.text, left: u.human, right: u.llm, status: u.status })),
    [doc]
  );
  const { lang, t } = useI18n();
  const statuses: DiffStatus[] = DIFF_STATUSES.map(([k, key, c]) => [k, t(key), c]);
  const relevantCount = onlyAi.filter(
    (f) => relevance[findingKey(doc.name, f)] === "relevant"
  ).length;
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(2));

  return (
    <div className="compare-report">
      <h3>{doc.name}</h3>

      <h4>{t("hl.lexical")}</h4>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th>{t("common.code")}</th>
              <th title={t("hl.precision")}>P</th>
              <th title={t("hl.recall")}>R</th>
              <th title={t("hl.f1")}>F1</th>
              <th title={t("metric.kappaTitle")}>κ</th>
              <th title={t("hl.tp")}>TP</th>
              <th title={t("hl.fp")}>FP</th>
              <th title={t("hl.fn")}>FN</th>
            </tr>
          </thead>
          <tbody>
            {doc.per_code.map((m) => (
              <tr key={m.code}>
                <td>{m.code}</td>
                <td>{m.precision.toFixed(2)}</td>
                <td>{m.recall.toFixed(2)}</td>
                <td>{m.f1.toFixed(2)}</td>
                <td>{fmt(m.kappa)}</td>
                <td>{m.tp}</td><td>{m.fp}</td><td>{m.fn}</td>
              </tr>
            ))}
            <tr className="total-row">
              <td>GLOBAL</td>
              <td>{doc.overall.precision.toFixed(2)}</td>
              <td>{doc.overall.recall.toFixed(2)}</td>
              <td>{doc.overall.f1.toFixed(2)}</td>
              <td>{fmt(doc.overall.kappa)}</td>
              <td colSpan={3}></td>
            </tr>
          </tbody>
        </table>
      </div>
      {lang === "es" ? (
        <p className="metrics-legend">
          <strong>P</strong> = Precisión (de lo que marcó el LLM, cuánto coincidió) ·{" "}
          <strong>R</strong> = Recall (de lo que marcó la persona, cuánto encontró el LLM) ·{" "}
          <strong>F1</strong> = media armónica de P y R ·{" "}
          <strong>κ</strong> = Cohen's kappa (acuerdo corregido por azar) ·{" "}
          <strong>TP</strong> = verdaderos positivos ·{" "}
          <strong>FP</strong> = falsos positivos ·{" "}
          <strong>FN</strong> = falsos negativos.
        </p>
      ) : (
        <p className="metrics-legend">
          <strong>P</strong> = Precision (of what the LLM marked, how much matched) ·{" "}
          <strong>R</strong> = Recall (of what the person marked, how much the LLM found) ·{" "}
          <strong>F1</strong> = harmonic mean of P and R ·{" "}
          <strong>κ</strong> = Cohen's kappa (chance-corrected agreement) ·{" "}
          <strong>TP</strong> = true positives ·{" "}
          <strong>FP</strong> = false positives ·{" "}
          <strong>FN</strong> = false negatives.
        </p>
      )}

      <h4>{t("compare.semantic", { model: embeddingModel })}</h4>
      <ThresholdControl value={threshold} onChange={onThreshold} />

      <div className="findings">
        <div className="finding-col">
          <h4 className="only-ai">
            {t("hl.onlyAi", { n: onlyAi.length, r: relevantCount })}
          </h4>
          <p className="meta">{t("hl.onlyAiHint")}</p>
          <ul className="finding-list">
            {onlyAi.map((f, i) => {
              const rel = relevance[findingKey(doc.name, f)];
              return (
                <FindingItem key={i} finding={f} otherLabel={t("hl.humanLower")}>
                  <div className="relevance-buttons">
                    <button
                      className={rel === "relevant" ? "rel-yes active" : "rel-yes"}
                      onClick={() => onMark(doc.name, f, "relevant")}
                    >
                      {t("hl.relevant")}
                    </button>
                    <button
                      className={rel === "no" ? "rel-no active" : "rel-no"}
                      onClick={() => onMark(doc.name, f, "no")}
                    >
                      {t("hl.notRelevant")}
                    </button>
                  </div>
                </FindingItem>
              );
            })}
            {onlyAi.length === 0 && <li className="meta">{t("compare.noneBelow")}</li>}
          </ul>
        </div>

        <div className="finding-col">
          <h4 className="only-human">{t("hl.onlyHuman", { n: onlyHuman.length })}</h4>
          <p className="meta">{t("hl.onlyHumanHint")}</p>
          <ul className="finding-list">
            {onlyHuman.map((f, i) => (
              <FindingItem key={i} finding={f} otherLabel="LLM" />
            ))}
            {onlyHuman.length === 0 && <li className="meta">{t("compare.noneBelow")}</li>}
          </ul>
        </div>
      </div>

      <DiffView
        units={diffUnits}
        statuses={statuses}
        leftLabel={t("hl.humanLower")}
        rightLabel="LLM"
      />
    </div>
  );
}
