// Visor que renderiza el texto completo de un documento resaltando los
// fragmentos codificados por color. Incluye:
// - filtro de códigos con contador por código,
// - resaltado en gris de los empalmes (2+ códigos visibles),
// - un panel FIJO (sticky) que muestra la(s) justificación(es) del fragmento al
//   hacer clic en un tramo resaltado; permanece visible al hacer scroll.
import { useEffect, useMemo, useState } from "react";
import type { Code, CodedDocument } from "../types";
import { buildSegments, type Segment } from "../highlight";
import { renderInlineMarkdown } from "../markdown";

interface HighlightViewerProps {
  doc: CodedDocument;
  codebook: Code[];
  /** Modelos del ensamble (solo en consenso); habilita mostrar el acuerdo. */
  ensembleModels?: string[];
}

// Color de los tramos con empalme (dos o más códigos visibles).
const OVERLAP_COLOR = "#9aa0a6";

export function HighlightViewer({
  doc,
  codebook,
  ensembleModels,
}: HighlightViewerProps) {
  // Índice etiqueta -> color para pintar por código.
  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of codebook) map.set(c.label, c.color);
    return map;
  }, [codebook]);

  // Códigos presentes en el documento y su conteo de fragmentos.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of doc.fragments) m.set(f.code, (m.get(f.code) ?? 0) + 1);
    return m;
  }, [doc]);

  // Códigos presentes, en el orden del codebook (leyenda/filtro estable).
  const codesInDoc = useMemo(
    () => codebook.map((c) => c.label).filter((l) => counts.has(l)),
    [codebook, counts]
  );

  // Selección de códigos a mostrar (por defecto, todos los del documento).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(codesInDoc));
  // Tramo seleccionado (para el panel de justificaciones), por su clave start-end.
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Al cambiar de documento, reinicia filtro y selección.
  useEffect(() => {
    setSelected(new Set(codesInDoc));
    setActiveKey(null);
  }, [doc.name]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Activa/desactiva un código del filtro. */
  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  const allOn = selected.size === codesInDoc.length;
  const segments = useMemo(() => buildSegments(doc), [doc]);

  // Segmento actualmente seleccionado y sus fragmentos visibles.
  const activeSegment = useMemo<Segment | null>(() => {
    if (!activeKey) return null;
    return segments.find((s) => `${s.start}-${s.end}` === activeKey) ?? null;
  }, [activeKey, segments]);
  const activeFragments = (activeSegment?.fragments ?? []).filter((f) =>
    selected.has(f.code)
  );

  return (
    <div className="viewer">
      <h3>{doc.name}</h3>

      {/* Filtro de códigos con contador por código. */}
      <div className="viewer-filter">
        <span className="filter-label">Códigos:</span>
        {codesInDoc.map((label) => (
          <label key={label} className="filter-item">
            <input
              type="checkbox"
              checked={selected.has(label)}
              onChange={() => toggle(label)}
            />
            <span
              className="swatch"
              style={{ background: colorOf.get(label) ?? "#999" }}
            />
            {label}
            <span className="count-badge">{counts.get(label)}</span>
          </label>
        ))}
        <button
          className="filter-toggle"
          onClick={() => setSelected(allOn ? new Set() : new Set(codesInDoc))}
        >
          {allOn ? "Ninguno" : "Todos"}
        </button>
      </div>

      {/* Panel FIJO de justificaciones (sticky: no se pierde al hacer scroll). */}
      <div className="justification-panel">
        {activeFragments.length === 0 ? (
          <p className="justification-hint">
            Haz clic en un fragmento resaltado para ver su justificación.
          </p>
        ) : (
          <div className="justification-content">
            <ul className="justification-list">
              {activeFragments.map((f, i) => (
                <li key={i}>
                  <span
                    className="swatch"
                    style={{ background: colorOf.get(f.code) ?? "#999" }}
                  />
                  <strong>{f.code}:</strong>{" "}
                  {/* Acuerdo entre modelos (solo en consenso). */}
                  {ensembleModels && f.models && f.models.length > 0 && (
                    <span
                      className="agreement-badge"
                      title={`Coincidieron: ${f.models.join(", ")}`}
                    >
                      {f.models.length}/{ensembleModels.length}
                    </span>
                  )}{" "}
                  {f.justification || <em>(sin justificación)</em>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="viewer-text">
        {segments.map((seg, i) => {
          const visible = seg.codes.filter((c) => selected.has(c));
          // El texto del segmento se renderiza como Markdown en línea (saneado).
          const html = { __html: renderInlineMarkdown(seg.text) };

          if (visible.length === 0) {
            return <span key={i} dangerouslySetInnerHTML={html} />;
          }

          const isOverlap = visible.length > 1;
          const bg = isOverlap ? OVERLAP_COLOR : colorOf.get(visible[0]) ?? "#999";
          const key = `${seg.start}-${seg.end}`;
          const isActive = key === activeKey;

          return (
            <mark
              key={i}
              className={`hl ${isOverlap ? "overlap" : ""} ${isActive ? "active" : ""}`}
              style={{ backgroundColor: bg + "66" }}
              title={visible.join(" + ")}
              onClick={() => setActiveKey(key)}
              dangerouslySetInnerHTML={html}
            />
          );
        })}
      </p>
    </div>
  );
}
