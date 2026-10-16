// Pestaña "Comparar" (Fase II): carga la codificación del LLM (JSON exportado) y
// la humana (CSV/XLSX), ejecuta POST /compare y muestra métricas léxicas,
// hallazgos semánticos (solo-IA por novedad, solo-humano) con su cita más
// parecida del otro lado, permite marcar la relevancia de los hallazgos solo-IA
// y exportar el reporte (JSON/CSV). Incluye un diff por oración.
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
import { parseAqaExport } from "../aqaFile";
import { csvRow, downloadBlob, downloadText } from "../download";

/** Colores del diff por estado de acuerdo. */
const STATUS_COLOR: Record<string, string> = {
  agree: "#2E933C",
  only_human: "#E4572E",
  only_llm: "#3A6EA5",
  partial: "#C9A227",
};

/** Marca que identifica un archivo de comparación guardado por la herramienta. */
const AQA_COMPARISON_KIND = "aqa-comparison-export";

/** Códigos de interés (se resaltan) con su color. */
const CODES_OF_INTEREST: Array<[string, string]> = [
  ["Barrera", "#E4572E"],
  ["Facilitador", "#2E933C"],
  ["Estrategia", "#3A6EA5"],
];

/** Relevancia marcada por la persona para un hallazgo solo-IA. */
type Relevance = "relevant" | "no";

/** Clave estable de un hallazgo (documento + span + código). */
function findingKey(docName: string, f: FragmentSim): string {
  return `${docName}|${f.start}-${f.end}|${f.code}`;
}

/** Devuelve el texto que rodea la cita en el documento, con la cita marcada «…». */
function contextAround(fullText: string, start: number, end: number, pad = 220): string {
  let a = Math.max(0, start - pad);
  let b = Math.min(fullText.length, end + pad);
  // Ajusta a límites de palabra para no cortar a mitad.
  if (a > 0) {
    const sp = fullText.indexOf(" ", a);
    if (sp !== -1 && sp < start) a = sp + 1;
  }
  if (b < fullText.length) {
    const sp = fullText.lastIndexOf(" ", b);
    if (sp !== -1 && sp > end) b = sp;
  }
  const before = fullText.slice(a, start);
  const quote = fullText.slice(start, end);
  const after = fullText.slice(end, b);
  return (
    (a > 0 ? "… " : "") + before + "«" + quote + "»" + after + (b < fullText.length ? " …" : "")
  );
}

/** Cuenta elementos por código (fragmentos con `.code`). */
function countByCode(items: { code: string }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of items) c[it.code] = (c[it.code] ?? 0) + 1;
  return c;
}

/** Cuenta las oraciones por estado de acuerdo del diff. */
function countStatuses(units: UnitDiff[]) {
  const c = { agree: 0, only_llm: 0, only_human: 0, partial: 0 };
  for (const u of units) {
    if (u.status in c) c[u.status as keyof typeof c]++;
  }
  return c;
}

export function CompareView() {
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
    setError(bad.length ? `No son JSON válidos: ${bad.join(", ")}` : undefined);
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
      setError(err instanceof ApiError ? err.message : "No se pudo leer el archivo humano");
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
      setError(err instanceof ApiError ? err.message : "Error al comparar");
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
      aqa: { tool: "Análisis Cualitativo Automático", version: "0.1.0", kind: AQA_COMPARISON_KIND },
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
        setError("El archivo no es una comparación válida guardada por la herramienta.");
        return;
      }
      setResult(data.result as ComparisonResult);
      setThreshold(typeof data.threshold === "number" ? data.threshold : 0.7);
      setRelevance(data.relevance ?? {});
      setActiveDoc(0);
    } catch {
      setError("No se pudo leer el archivo de comparación (¿JSON válido?).");
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
      setError(err instanceof ApiError ? err.message : "Error al generar el DOCX");
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Comparar humano vs LLM</h2>
        <p className="hint">
          Carga la codificación del <strong>LLM</strong> (JSON exportado por la
          herramienta) y la codificación <strong>humana</strong> (CSV o XLSX con
          columnas <em>document, quotation, codes, comment</em>) del mismo documento.
        </p>

        <div className="compare-inputs">
          <div>
            <button className="button" onClick={() => llmInput.current?.click()}>
              Cargar codificación LLM (JSON)
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
              {llmDocs.length > 0 ? ` ${llmDocs.length} documento(s)` : " ninguno"}
            </span>
          </div>

          <div>
            <label className="button">
              Cargar codificación humana (CSV/XLSX)
              <input
                type="file"
                accept=".csv,.xlsx"
                hidden
                onChange={(e) => onHumanFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="meta">{humanFile ? ` ${humanFile.name}` : " ninguno"}</span>
          </div>

          <button
            className="primary big"
            disabled={busy || llmDocs.length === 0 || !humanFile}
            onClick={runCompare}
          >
            {busy ? "Comparando…" : "▶ Comparar"}
          </button>

          <div className="compare-load">
            <span className="meta">o cargar una comparación guardada:</span>
            <label className="button">
              Cargar comparación (JSON)
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
            {result.unmapped.length} cita(s) humana(s) no se encontraron en el texto.
          </p>
        )}
        {result && (
          <div className="result-actions">
            <button className="button" onClick={exportDocx}>⬇ Hallazgos IA (DOCX)</button>
            <button className="button" onClick={saveComparison}>⬇ Guardar comparación (JSON)</button>
            <button className="button" onClick={exportCsv}>↓ Hallazgos (CSV)</button>
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
  const interest = CODES_OF_INTEREST.map(([c]) => c);
  // Códigos de interés primero (en orden), luego el resto presente en cualquier lado.
  const others = Array.from(
    new Set([...Object.keys(human.by_code), ...Object.keys(llm)])
  )
    .filter((c) => !interest.includes(c))
    .sort();
  const rows = [...interest, ...others];
  const colorOf = (c: string) => CODES_OF_INTEREST.find(([x]) => x === c)?.[1];

  return (
    <div className="panel">
      <h3>Conteo de citas por código</h3>
      <p className="meta">
        Codificación humana: <strong>{human.total}</strong> citas
        {human.documents.length > 0 && ` · ${human.documents.length} documento(s)`}
        {hasLlm && " · comparado con las citas del/los LLM cargados"}.
      </p>
      <div className="table-scroll">
        <table className="metrics-table counts-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Humano</th>
              {hasLlm && <th>LLM</th>}
              {hasLlm && <th>Δ (LLM − Humano)</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((code) => {
              const h = human.by_code[code] ?? 0;
              const l = llm[code] ?? 0;
              if (h === 0 && l === 0) return null;
              const color = colorOf(code);
              return (
                <tr key={code} className={color ? "interest" : ""}>
                  <td style={color ? { borderLeft: `4px solid ${color}` } : undefined}>
                    {color && <span className="swatch" style={{ background: color }} />}
                    {code}
                  </td>
                  <td>{h}</td>
                  {hasLlm && <td>{l}</td>}
                  {hasLlm && (
                    <td className={l - h > 0 ? "delta-pos" : l - h < 0 ? "delta-neg" : ""}>
                      {l - h > 0 ? `+${l - h}` : l - h}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!hasLlm && (
        <p className="meta">
          Carga la codificación del LLM (arriba) para ver la comparativa lado a lado.
        </p>
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
  const onlyAi = useMemo(
    () => doc.llm_fragments.filter((f) => f.max_similarity < threshold)
      .sort((a, b) => a.max_similarity - b.max_similarity),
    [doc, threshold]
  );
  const onlyHuman = useMemo(
    () => doc.human_fragments.filter((f) => f.max_similarity < threshold)
      .sort((a, b) => a.max_similarity - b.max_similarity),
    [doc, threshold]
  );
  const diffCounts = useMemo(() => countStatuses(doc.units), [doc]);
  // Estados del diff visibles (todos por defecto). Debe quedar al menos uno.
  const [visibleStatuses, setVisibleStatuses] = useState<Set<string>>(
    () => new Set(["agree", "only_llm", "only_human", "partial"])
  );
  function toggleStatus(s: string) {
    setVisibleStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        if (next.size > 1) next.delete(s); // no permitir desmarcar el último
      } else {
        next.add(s);
      }
      return next;
    });
  }
  const relevantCount = onlyAi.filter(
    (f) => relevance[findingKey(doc.name, f)] === "relevant"
  ).length;
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(2));

  return (
    <div className="compare-report">
      <h3>{doc.name}</h3>

      <h4>Acuerdo léxico (humano = referencia)</h4>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th>Código</th>
              <th title="Precisión">P</th>
              <th title="Recall (sensibilidad)">R</th>
              <th title="F1: media armónica de P y R">F1</th>
              <th title="Cohen's kappa: acuerdo corregido por azar">κ</th>
              <th title="Verdaderos positivos">TP</th>
              <th title="Falsos positivos">FP</th>
              <th title="Falsos negativos">FN</th>
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
      <p className="metrics-legend">
        <strong>P</strong> = Precisión (de lo que marcó el LLM, cuánto coincidió) ·{" "}
        <strong>R</strong> = Recall (de lo que marcó la persona, cuánto encontró el LLM) ·{" "}
        <strong>F1</strong> = media armónica de P y R ·{" "}
        <strong>κ</strong> = Cohen's kappa (acuerdo corregido por azar) ·{" "}
        <strong>TP</strong> = verdaderos positivos ·{" "}
        <strong>FP</strong> = falsos positivos ·{" "}
        <strong>FN</strong> = falsos negativos.
      </p>

      <h4>Similitud semántica (embeddings: {embeddingModel})</h4>
      <label className="threshold-control">
        Umbral de "mismo hallazgo": <strong>{threshold.toFixed(2)}</strong>
        <input
          type="range" min={0} max={1} step={0.05} value={threshold}
          onChange={(e) => onThreshold(Number(e.target.value))}
        />
      </label>

      <div className="findings">
        <div className="finding-col">
          <h4 className="only-ai">
            ★ Hallazgos solo-IA ({onlyAi.length}) · relevantes: {relevantCount}
          </h4>
          <p className="meta">Ordenados por novedad; marca su relevancia.</p>
          <ul className="finding-list">
            {onlyAi.map((f, i) => {
              const rel = relevance[findingKey(doc.name, f)];
              return (
                <li key={i}>
                  <span className="tag">{f.code}</span>
                  <span className="sim">sim {f.max_similarity.toFixed(2)}</span>
                  <div className="finding-quote">“{f.quote}”</div>
                  {f.justification && <div className="finding-just">{f.justification}</div>}
                  {f.best_match_quote && (
                    <div className="finding-match">
                      ≈ más parecido (humano): “{f.best_match_quote}” [{f.best_match_code}]
                    </div>
                  )}
                  <div className="relevance-buttons">
                    <button
                      className={rel === "relevant" ? "rel-yes active" : "rel-yes"}
                      onClick={() => onMark(doc.name, f, "relevant")}
                    >
                      ✓ Relevante
                    </button>
                    <button
                      className={rel === "no" ? "rel-no active" : "rel-no"}
                      onClick={() => onMark(doc.name, f, "no")}
                    >
                      ✗ No
                    </button>
                  </div>
                </li>
              );
            })}
            {onlyAi.length === 0 && <li className="meta">Ninguno bajo el umbral.</li>}
          </ul>
        </div>

        <div className="finding-col">
          <h4 className="only-human">Hallazgos solo-humano ({onlyHuman.length})</h4>
          <p className="meta">Lo que el LLM no capturó.</p>
          <ul className="finding-list">
            {onlyHuman.map((f, i) => (
              <li key={i}>
                <span className="tag">{f.code}</span>
                <span className="sim">sim {f.max_similarity.toFixed(2)}</span>
                <div className="finding-quote">“{f.quote}”</div>
                {f.comment && <div className="finding-just">💬 {f.comment}</div>}
                {f.best_match_quote && (
                  <div className="finding-match">
                    ≈ más parecido (LLM): “{f.best_match_quote}” [{f.best_match_code}]
                  </div>
                )}
              </li>
            ))}
            {onlyHuman.length === 0 && <li className="meta">Ninguno bajo el umbral.</li>}
          </ul>
        </div>
      </div>

      <h4>Diff por oración</h4>
      <p className="meta">Marca los estados a resaltar (al menos uno).</p>
      <div className="diff-summary">
        {([
          ["agree", "acuerdo"],
          ["only_llm", "solo LLM"],
          ["only_human", "solo humano"],
          ["partial", "parcial"],
        ] as const).map(([s, label]) => (
          <label key={s} className="stat" style={{ borderColor: STATUS_COLOR[s] }}>
            <input
              type="checkbox"
              checked={visibleStatuses.has(s)}
              onChange={() => toggleStatus(s)}
            />
            <b>{diffCounts[s]}</b> {label}
          </label>
        ))}
      </div>
      <p className="viewer-text">
        {doc.units.map((u, i) => {
          // Texto plano si no está codificada o su estado está oculto por el filtro.
          if (u.status === "none" || !visibleStatuses.has(u.status)) {
            return <span key={i}>{u.text} </span>;
          }
          const color = STATUS_COLOR[u.status] ?? "#999";
          return (
            <mark
              key={i}
              className="hl"
              style={{ backgroundColor: color + "44" }}
              title={`humano: ${u.human.join(", ") || "—"} | LLM: ${u.llm.join(", ") || "—"}`}
            >
              {u.text}{" "}
            </mark>
          );
        })}
      </p>
    </div>
  );
}
