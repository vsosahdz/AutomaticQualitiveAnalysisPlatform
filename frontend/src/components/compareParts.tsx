// Piezas de la pestaña Comparar compartidas por los modos "Humano vs LLM" y
// "A vs B": tabla de conteos por código, lista de hallazgos con su cita más
// parecida, control de umbral y diff por oración con filtro de estados. Se
// parametrizan con los nombres de cada lado.
import { useMemo, useState, type ReactNode } from "react";
import type { FragmentSim } from "../types";
import { useI18n } from "../i18n";

/** Códigos de interés (se resaltan) con su color. */
export const CODES_OF_INTEREST: Array<[string, string]> = [
  ["Barrera", "#E4572E"],
  ["Facilitador", "#2E933C"],
  ["Estrategia", "#3A6EA5"],
];

/** Devuelve el texto que rodea la cita en el documento, con la cita marcada «…». */
export function contextAround(fullText: string, start: number, end: number, pad = 220): string {
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
export function countByCode(items: { code: string }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of items) c[it.code] = (c[it.code] ?? 0) + 1;
  return c;
}

// --- Tabla de conteos por código --------------------------------------------

interface CountsTableProps {
  leftLabel: string;
  left: Record<string, number>;
  /** Lado derecho opcional (si falta, solo se muestra la columna izquierda). */
  rightLabel?: string;
  right?: Record<string, number>;
}

/** Tabla de citas por código de uno o dos lados, resaltando los 3 de interés. */
export function CountsTable({ leftLabel, left, rightLabel, right }: CountsTableProps) {
  const { t } = useI18n();
  const interest = CODES_OF_INTEREST.map(([c]) => c);
  // Códigos de interés primero (en orden), luego el resto presente en cualquier lado.
  const others = Array.from(new Set([...Object.keys(left), ...Object.keys(right ?? {})]))
    .filter((c) => !interest.includes(c))
    .sort();
  const rows = [...interest, ...others];
  const colorOf = (c: string) => CODES_OF_INTEREST.find(([x]) => x === c)?.[1];
  const hasRight = right !== undefined;

  return (
    <div className="table-scroll">
      <table className="metrics-table counts-table">
        <thead>
          <tr>
            <th>{t("common.code")}</th>
            <th>{leftLabel}</th>
            {hasRight && <th>{rightLabel}</th>}
            {hasRight && (
              <th>
                Δ ({rightLabel} − {leftLabel})
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((code) => {
            const l = left[code] ?? 0;
            const r = right?.[code] ?? 0;
            if (l === 0 && r === 0) return null;
            const color = colorOf(code);
            const delta = r - l;
            return (
              <tr key={code} className={color ? "interest" : ""}>
                <td style={color ? { borderLeft: `4px solid ${color}` } : undefined}>
                  {color && <span className="swatch" style={{ background: color }} />}
                  {code}
                </td>
                <td>{l}</td>
                {hasRight && <td>{r}</td>}
                {hasRight && (
                  <td className={delta > 0 ? "delta-pos" : delta < 0 ? "delta-neg" : ""}>
                    {delta > 0 ? `+${delta}` : delta}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Umbral y hallazgos -----------------------------------------------------

interface ThresholdControlProps {
  value: number;
  onChange: (v: number) => void;
}

/** Control deslizante del umbral de "mismo hallazgo". */
export function ThresholdControl({ value, onChange }: ThresholdControlProps) {
  const { t } = useI18n();
  return (
    <label className="threshold-control">
      {t("compare.threshold")} <strong>{value.toFixed(2)}</strong>
      <input
        type="range" min={0} max={1} step={0.05} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

interface FindingItemProps {
  finding: FragmentSim;
  /** Nombre del otro lado, para "≈ más parecido (…)". */
  otherLabel: string;
  /** Acciones adicionales (p. ej. marcar relevancia). */
  children?: ReactNode;
}

/** Un hallazgo: código, similitud, cita, nota (justificación o comentario) y su par. */
export function FindingItem({ finding: f, otherLabel, children }: FindingItemProps) {
  const { t } = useI18n();
  return (
    <li>
      <span className="tag">{f.code}</span>
      <span className="sim">sim {f.max_similarity.toFixed(2)}</span>
      <div className="finding-quote">“{f.quote}”</div>
      {f.justification && <div className="finding-just">{f.justification}</div>}
      {f.comment && <div className="finding-just">💬 {f.comment}</div>}
      {f.best_match_quote && (
        <div className="finding-match">
          {t("compare.closest", { other: otherLabel })} “{f.best_match_quote}” [{f.best_match_code}]
        </div>
      )}
      {children}
    </li>
  );
}

/** Hallazgos de un lado por debajo del umbral, de más a menos novedoso. */
export function belowThreshold(items: FragmentSim[], threshold: number): FragmentSim[] {
  return items
    .filter((f) => f.max_similarity < threshold)
    .sort((a, b) => a.max_similarity - b.max_similarity);
}

// --- Diff por oración -------------------------------------------------------

/** Una oración del diff, con los códigos de cada lado. */
export interface DiffUnit {
  text: string;
  left: string[];
  right: string[];
  status: string;
}

/** Un estado del diff: clave, etiqueta y color. */
export type DiffStatus = [key: string, label: string, color: string];

interface DiffViewProps {
  units: DiffUnit[];
  statuses: DiffStatus[];
  leftLabel: string;
  rightLabel: string;
}

/** Cuenta las oraciones por estado de acuerdo. */
export function countStatuses(units: { status: string }[], keys: string[]): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const u of units) if (u.status in c) c[u.status]++;
  return c;
}

/** Diff por oración con conteo y filtro de estados (siempre al menos uno activo). */
export function DiffView({ units, statuses, leftLabel, rightLabel }: DiffViewProps) {
  const { t } = useI18n();
  const keys = statuses.map(([k]) => k);
  const counts = useMemo(() => countStatuses(units, keys), [units]); // eslint-disable-line react-hooks/exhaustive-deps
  const [visible, setVisible] = useState<Set<string>>(() => new Set(keys));
  const colorOf = Object.fromEntries(statuses.map(([k, , c]) => [k, c]));

  function toggle(s: string) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        if (next.size > 1) next.delete(s); // no permitir desmarcar el último
      } else {
        next.add(s);
      }
      return next;
    });
  }

  return (
    <>
      <h4>{t("compare.diffTitle")}</h4>
      <p className="meta">{t("compare.diffHint")}</p>
      <div className="diff-summary">
        {statuses.map(([s, label, color]) => (
          <label key={s} className="stat" style={{ borderColor: color }}>
            <input type="checkbox" checked={visible.has(s)} onChange={() => toggle(s)} />
            <b>{counts[s]}</b> {label}
          </label>
        ))}
      </div>
      <p className="viewer-text">
        {units.map((u, i) => {
          // Texto plano si no está codificada o su estado está oculto por el filtro.
          if (u.status === "none" || !visible.has(u.status)) {
            return <span key={i}>{u.text} </span>;
          }
          const color = colorOf[u.status] ?? "#999";
          return (
            <mark
              key={i}
              className="hl"
              style={{ backgroundColor: color + "44" }}
              title={`${leftLabel}: ${u.left.join(", ") || "—"} | ${rightLabel}: ${u.right.join(", ") || "—"}`}
            >
              {u.text}{" "}
            </mark>
          );
        })}
      </p>
    </>
  );
}
