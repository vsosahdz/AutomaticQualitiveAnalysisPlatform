// Modo "A vs B" de la pestaña Comparar: compara dos codificaciones cualesquiera.
// Cada lado es un CSV/XLSX humano o uno o varios JSON exportados por la
// herramienta (incluidos los editados por personas). Las transcripciones TXT
// aportan el texto cuando ningún lado lo trae. Las métricas son simétricas
// (kappa, acuerdo observado y acuerdo específico positivo): ningún lado es la
// referencia.
import { useMemo, useState } from "react";
import type { PairComparisonResult, PairDocumentComparison } from "../types";
import { ApiError, compareAB } from "../api";
import { AQA_TOOL, AQA_VERSION, baseName } from "../aqaFile";
import { csvRow, downloadText } from "../download";
import {
  belowThreshold,
  countByCode,
  CountsTable,
  DiffView,
  FindingItem,
  ThresholdControl,
  type DiffStatus,
} from "./compareParts";
import { useI18n } from "../i18n";

/** Marca de un archivo de comparación A vs B guardado por la herramienta. */
const AQA_PAIR_KIND = "aqa-pair-comparison-export";

/** Tipo de archivos de un lado según su extensión. */
type SideKind = "csv" | "json";

/** Estado de carga de un lado. */
interface SideState {
  files: File[];
  label: string;
  /** El nombre lo escribió la persona (no se reemplaza al cambiar los archivos). */
  labelEdited: boolean;
}

const EMPTY_SIDE = (label: string): SideState => ({ files: [], label, labelEdited: false });

function kindOf(files: File[]): SideKind | "mixed" | null {
  if (files.length === 0) return null;
  const kinds = new Set(files.map((f) => (f.name.toLowerCase().endsWith(".json") ? "json" : "csv")));
  return kinds.size > 1 ? "mixed" : (Array.from(kinds)[0] as SideKind);
}

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(2));

export function PairCompareView() {
  const { lang, t } = useI18n();
  const [a, setA] = useState<SideState>(EMPTY_SIDE("A"));
  const [b, setB] = useState<SideState>(EMPTY_SIDE("B"));
  const [transcripts, setTranscripts] = useState<File[]>([]);
  const [result, setResult] = useState<PairComparisonResult | null>(null);
  const [threshold, setThreshold] = useState(0.7);
  const [activeDoc, setActiveDoc] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const kindA = kindOf(a.files);
  const kindB = kindOf(b.files);
  const anyJson = kindA === "json" || kindB === "json";
  // Sin JSON en ningún lado, el texto solo puede venir de las transcripciones.
  const needsTranscripts = kindA !== null && kindB !== null && !anyJson;
  const sideError =
    kindA === "mixed" || kindB === "mixed"
      ? t("pair.mixed")
      : (kindA === "csv" && a.files.length > 1) || (kindB === "csv" && b.files.length > 1)
        ? t("pair.oneCsv")
        : undefined;
  const canCompare =
    !busy && !sideError && !!kindA && !!kindB && (!needsTranscripts || transcripts.length > 0);

  /** Asigna los archivos de un lado y, si no se editó, su nombre por defecto. */
  function setFiles(
    setter: React.Dispatch<React.SetStateAction<SideState>>,
    files: FileList | null,
    fallback: string
  ) {
    const list = Array.from(files ?? []);
    setter((prev) => ({
      ...prev,
      files: list,
      label: prev.labelEdited
        ? prev.label
        : list.length === 1
          ? baseName(list[0].name)
          : list.length > 1
            ? t("pair.nFiles", { label: fallback, n: list.length })
            : fallback,
    }));
  }

  async function runCompare() {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const res = await compareAB(a.files, b.files, transcripts, a.label, b.label);
      setResult(res);
      setThreshold(res.default_threshold);
      setActiveDoc(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("compare.error"));
    } finally {
      setBusy(false);
    }
  }

  /** Guarda la comparación completa (recargable): resultado + umbral. */
  function saveComparison() {
    if (!result) return;
    const payload = {
      aqa: { tool: AQA_TOOL, version: AQA_VERSION, kind: AQA_PAIR_KIND },
      threshold,
      result,
    };
    downloadText(JSON.stringify(payload, null, 2), "comparacion_AB_AQA.json", "application/json");
  }

  /** Carga una comparación A vs B guardada y la muestra sin recomputar. */
  async function loadComparison(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(undefined);
    try {
      const data = JSON.parse(await files[0].text());
      if (data?.aqa?.kind !== AQA_PAIR_KIND || !data.result) {
        setError(t("pair.invalidSaved"));
        return;
      }
      setResult(data.result as PairComparisonResult);
      setThreshold(typeof data.threshold === "number" ? data.threshold : 0.7);
      setActiveDoc(0);
    } catch {
      setError(t("compare.readError"));
    }
  }

  /** Exporta los hallazgos de ambos lados a CSV (una fila por hallazgo). */
  function exportCsv() {
    if (!result) return;
    const header = [
      "tipo", "lado", "documento", "codigo", "cita", "similitud",
      "cita_mas_parecida", "codigo_parecido", "nota",
    ];
    const lines = [csvRow(header)];
    for (const d of result.documents) {
      for (const [label, frags] of [
        [result.a_label, d.a_fragments],
        [result.b_label, d.b_fragments],
      ] as const) {
        for (const f of frags) {
          const tipo = f.max_similarity < threshold ? `solo-${label}` : "acuerdo";
          lines.push(csvRow([tipo, label, d.name, f.code, f.quote, f.max_similarity,
            f.best_match_quote, f.best_match_code, f.justification || f.comment]));
        }
      }
    }
    downloadText(lines.join("\n"), "comparacion_AB_hallazgos.csv", "text/csv", true);
  }

  // Conteo de citas por código de cada lado (del resultado).
  const counts = useMemo(
    () =>
      result && {
        a: countByCode(result.documents.flatMap((d) => d.a_fragments)),
        b: countByCode(result.documents.flatMap((d) => d.b_fragments)),
      },
    [result]
  );

  return (
    <div>
      <div className="panel">
        <h2>{t("pair.title")}</h2>
        {lang === "es" ? (
          <p className="hint">
            Cada lado puede ser una codificación <strong>humana</strong> (CSV o XLSX con
            columnas <em>document, quotation, codes, comment</em>) o uno o varios{" "}
            <strong>JSON</strong> exportados por la herramienta, incluidos los editados
            por una persona. Las métricas son simétricas: ningún lado es la referencia.
          </p>
        ) : (
          <p className="hint">
            Each side can be a <strong>human</strong> coding (CSV or XLSX with the
            columns <em>document, quotation, codes, comment</em>) or one or more{" "}
            <strong>JSON</strong> files exported by the tool, including ones edited by
            a person. The metrics are symmetric: neither side is the reference.
          </p>
        )}

        <div className="pair-inputs">
          <SideInput side={a} title={t("pair.sideA")} onFiles={(f) => setFiles(setA, f, "A")} onLabel={(label) => setA((p) => ({ ...p, label, labelEdited: true }))} />
          <SideInput side={b} title={t("pair.sideB")} onFiles={(f) => setFiles(setB, f, "B")} onLabel={(label) => setB((p) => ({ ...p, label, labelEdited: true }))} />
        </div>

        <div className="pair-transcripts">
          <label className="button">
            {t("pair.loadTxt")}
            <input
              type="file"
              accept=".txt,text/plain"
              multiple
              hidden
              onChange={(e) => setTranscripts(Array.from(e.target.files ?? []))}
            />
          </label>
          <span className="meta">
            {transcripts.length > 0
              ? ` ${transcripts.map((f) => f.name).join(", ")}`
              : needsTranscripts
                ? t("pair.txtNeeded")
                : anyJson
                  ? t("pair.txtOptional")
                  : t("common.noneF")}
          </span>
        </div>

        <div className="pair-actions">
          <button className="primary big" disabled={!canCompare} onClick={runCompare}>
            {busy ? t("compare.comparing") : t("compare.run")}
          </button>
          <div className="compare-load">
            <span className="meta">{t("pair.orLoad")}</span>
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

        {(sideError || error) && <p className="error">{sideError ?? error}</p>}
        {result && <ResultNotes result={result} />}
        {result && (
          <div className="result-actions">
            <button className="button" onClick={saveComparison}>{t("compare.save")}</button>
            <button className="button" onClick={exportCsv}>{t("compare.csv")}</button>
          </div>
        )}
      </div>

      {result && counts && (
        <div className="panel">
          <h3>{t("compare.countsTitle")}</h3>
          <CountsTable
            leftLabel={result.a_label}
            left={counts.a}
            rightLabel={result.b_label}
            right={counts.b}
          />
        </div>
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
          <PairReport
            doc={result.documents[Math.min(activeDoc, result.documents.length - 1)]}
            aLabel={result.a_label}
            bLabel={result.b_label}
            embeddingModel={result.embedding_model}
            threshold={threshold}
            onThreshold={setThreshold}
          />
        </div>
      )}
    </div>
  );
}

interface SideInputProps {
  side: SideState;
  title: string;
  onFiles: (files: FileList | null) => void;
  onLabel: (label: string) => void;
}

/** Carga de archivos y nombre de un lado. */
function SideInput({ side, title, onFiles, onLabel }: SideInputProps) {
  const { t } = useI18n();
  return (
    <div className="pair-side">
      <h4>{title}</h4>
      <label className="button">
        {t("pair.loadSide")}
        <input
          type="file"
          accept=".csv,.xlsx,.json,application/json"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
      </label>
      <span className="meta">
        {side.files.length > 0 ? ` ${side.files.map((f) => f.name).join(", ")}` : t("common.none")}
      </span>
      <label className="pair-label">
        {t("pair.name")}{" "}
        <input type="text" value={side.label} onChange={(e) => onLabel(e.target.value)} />
      </label>
    </div>
  );
}

/** Avisos del resultado: documentos sin texto, citas no ubicadas y conflictos. */
function ResultNotes({ result }: { result: PairComparisonResult }) {
  const { t } = useI18n();
  const items = [
    result.missing_text.length > 0 &&
      t("pair.missing", { n: result.missing_text.length, docs: result.missing_text.join(", ") }),
    result.unmapped_a.length > 0 &&
      t("pair.unmapped", { n: result.unmapped_a.length, label: result.a_label }),
    result.unmapped_b.length > 0 &&
      t("pair.unmapped", { n: result.unmapped_b.length, label: result.b_label }),
    ...result.notes,
  ].filter(Boolean) as string[];
  if (items.length === 0) return null;
  return (
    <ul className="dropped-note pair-notes">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

interface PairReportProps {
  doc: PairDocumentComparison;
  aLabel: string;
  bLabel: string;
  embeddingModel: string;
  threshold: number;
  onThreshold: (v: number) => void;
}

/** Reporte de un documento A vs B: métricas simétricas, hallazgos exclusivos y diff. */
function PairReport({ doc, aLabel, bLabel, embeddingModel, threshold, onThreshold }: PairReportProps) {
  const onlyA = useMemo(() => belowThreshold(doc.a_fragments, threshold), [doc, threshold]);
  const onlyB = useMemo(() => belowThreshold(doc.b_fragments, threshold), [doc, threshold]);
  const diffUnits = useMemo(
    () => doc.units.map((u) => ({ text: u.text, left: u.a, right: u.b, status: u.status })),
    [doc]
  );
  const { lang, t } = useI18n();
  const statuses: DiffStatus[] = [
    ["agree", t("diff.agree"), "#2E933C"],
    ["only_a", t("diff.only", { label: aLabel }), "#E4572E"],
    ["only_b", t("diff.only", { label: bLabel }), "#3A6EA5"],
    ["partial", t("diff.partial"), "#C9A227"],
  ];

  return (
    <div className="compare-report">
      <h3>{doc.name}</h3>

      <h4>{t("pair.agreement", { a: aLabel, b: bLabel })}</h4>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th>{t("common.code")}</th>
              <th title={t("metric.kappaTitle")}>κ</th>
              <th title={t("pair.aoTitle")}>Ao</th>
              <th title={t("pair.apTitle")}>Ap</th>
              <th title={t("pair.bothTitle")}>{t("pair.both")}</th>
              <th title={t("pair.onlyTitle", { label: aLabel })}>{t("pair.only", { label: aLabel })}</th>
              <th title={t("pair.onlyTitle", { label: bLabel })}>{t("pair.only", { label: bLabel })}</th>
            </tr>
          </thead>
          <tbody>
            {doc.per_code.map((m) => (
              <tr key={m.code}>
                <td>{m.code}</td>
                <td>{fmt(m.kappa)}</td>
                <td>{fmt(m.observed_agreement)}</td>
                <td>{fmt(m.positive_agreement)}</td>
                <td>{m.both}</td><td>{m.only_a}</td><td>{m.only_b}</td>
              </tr>
            ))}
            <tr className="total-row">
              <td>GLOBAL</td>
              <td>{fmt(doc.overall.kappa)}</td>
              <td>{fmt(doc.overall.observed_agreement)}</td>
              <td>{fmt(doc.overall.positive_agreement)}</td>
              <td colSpan={3}></td>
            </tr>
          </tbody>
        </table>
      </div>
      {lang === "es" ? (
        <p className="metrics-legend">
          <strong>κ</strong> = Cohen's kappa (acuerdo corregido por azar) ·{" "}
          <strong>Ao</strong> = acuerdo observado (oraciones en que ambos coinciden, con o sin el código) ·{" "}
          <strong>Ap</strong> = acuerdo específico positivo (coincidencia sobre las oraciones que alguno marcó).
          La alineación es por oración: dos citas de la misma oración cuentan como coincidencia.
        </p>
      ) : (
        <p className="metrics-legend">
          <strong>κ</strong> = Cohen's kappa (chance-corrected agreement) ·{" "}
          <strong>Ao</strong> = observed agreement (sentences where both agree, with or without the code) ·{" "}
          <strong>Ap</strong> = positive specific agreement (agreement over the sentences either side marked).
          Alignment is by sentence: two quotations from the same sentence count as a match.
        </p>
      )}

      <h4>{t("compare.semantic", { model: embeddingModel })}</h4>
      <ThresholdControl value={threshold} onChange={onThreshold} />

      <div className="findings">
        <div className="finding-col">
          <h4 className="only-human">{t("pair.onlyFindings", { label: aLabel, n: onlyA.length })}</h4>
          <p className="meta">{t("pair.onlyHint", { other: bLabel })}</p>
          <ul className="finding-list">
            {onlyA.map((f, i) => (
              <FindingItem key={i} finding={f} otherLabel={bLabel} />
            ))}
            {onlyA.length === 0 && <li className="meta">{t("compare.noneBelow")}</li>}
          </ul>
        </div>
        <div className="finding-col">
          <h4 className="only-ai">{t("pair.onlyFindings", { label: bLabel, n: onlyB.length })}</h4>
          <p className="meta">{t("pair.onlyHint", { other: aLabel })}</p>
          <ul className="finding-list">
            {onlyB.map((f, i) => (
              <FindingItem key={i} finding={f} otherLabel={aLabel} />
            ))}
            {onlyB.length === 0 && <li className="meta">{t("compare.noneBelow")}</li>}
          </ul>
        </div>
      </div>

      <DiffView units={diffUnits} statuses={statuses} leftLabel={aLabel} rightLabel={bLabel} />
    </div>
  );
}
