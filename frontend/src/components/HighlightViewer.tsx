// Visor que renderiza el texto completo de un documento resaltando los
// fragmentos codificados por color. Incluye:
// - filtro de códigos con contador por código,
// - resaltado en gris de los empalmes (2+ códigos visibles),
// - un panel FIJO (sticky) que muestra la(s) justificación(es) del fragmento al
//   hacer clic en un tramo resaltado; permanece visible al hacer scroll,
// - un modo de edición (opcional) para ajustar, agregar, reetiquetar, justificar
//   y eliminar hallazgos. En ese modo el texto se muestra sin interpretar el
//   Markdown, para que cada carácter seleccionado sea su posición en el original.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Code, CodedDocument, Fragment, FragmentOrigin } from "../types";
import { buildSegments, type Segment } from "../highlight";
import { renderInlineMarkdown } from "../markdown";
import {
  addFragment,
  editFragment,
  originOf,
  removeFragment,
  type EditResult,
  type FragmentChanges,
} from "../editing";
import { rangeToOffsets } from "../selection";
import { useI18n } from "../i18n";

/** Acciones de edición que ofrece el contenedor del visor. */
export interface ViewerEditing {
  /** Etiquetas permitidas: las del análisis. */
  allowedLabels: string[];
  /** Aplica una operación al documento visualizado. */
  apply: (op: (doc: CodedDocument) => EditResult) => EditResult;
  undo: () => void;
  canUndo: boolean;
}

interface HighlightViewerProps {
  doc: CodedDocument;
  codebook: Code[];
  /** Modelos del ensamble (solo en consenso); habilita mostrar el acuerdo. */
  ensembleModels?: string[];
  /** Si se proporciona, habilita el modo de edición de hallazgos. */
  editing?: ViewerEditing;
}

// Color de los tramos con empalme (dos o más códigos visibles).
const OVERLAP_COLOR = "#9aa0a6";

/** Clave del texto legible del origen de un fragmento. */
const ORIGIN_KEY = {
  llm: "origin.llm",
  editado: "origin.editado",
  manual: "origin.manual",
} as const satisfies Record<FragmentOrigin, string>;

/** Recorta una cita larga para mostrarla en una línea. */
function shortQuote(text: string, max = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Mensaje de estado del modo edición. */
interface Notice {
  kind: "error" | "info";
  text: string;
}

export function HighlightViewer({
  doc,
  codebook,
  ensembleModels,
  editing,
}: HighlightViewerProps) {
  const { t } = useI18n();
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

  // Códigos presentes: primero en el orden del codebook, luego los que no estén en él.
  const codesInDoc = useMemo(() => {
    const ordered = codebook.map((c) => c.label).filter((l) => counts.has(l));
    const rest = Array.from(counts.keys()).filter((l) => !ordered.includes(l)).sort();
    return [...ordered, ...rest];
  }, [codebook, counts]);

  // Códigos ocultos por el filtro (los nuevos códigos aparecen visibles).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Posición (offset) del tramo seleccionado para el panel de justificaciones.
  const [activePos, setActivePos] = useState<number | null>(null);

  // Estado del modo edición.
  const [editMode, setEditMode] = useState(false);
  const [pending, setPending] = useState<{ start: number; end: number } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingJust, setPendingJust] = useState("");
  const [adjusting, setAdjusting] = useState<Fragment | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  // Ignora el click que el navegador dispara tras una selección ya procesada.
  const skipClick = useRef(false);

  const allowedLabels = editing?.allowedLabels ?? [];
  const canEdit = !!editing && allowedLabels.length > 0;

  // Al cambiar de documento, reinicia filtro, selección y edición en curso.
  useEffect(() => {
    setHidden(new Set());
    setActivePos(null);
    setPending(null);
    setAdjusting(null);
    setNotice(null);
  }, [doc.name]);

  // Escape cancela el ajuste o el alta en curso.
  useEffect(() => {
    if (!adjusting && !pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAdjusting(null);
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adjusting, pending]);

  /** Activa/desactiva un código del filtro. */
  function toggle(label: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  const allOn = codesInDoc.every((l) => !hidden.has(l));
  const segments = useMemo(() => buildSegments(doc), [doc]);

  // Segmento que contiene la posición activa y sus fragmentos visibles.
  const activeSegment = useMemo<Segment | null>(() => {
    if (activePos === null) return null;
    return segments.find((s) => s.start <= activePos && activePos < s.end) ?? null;
  }, [activePos, segments]);
  const activeFragments = (activeSegment?.fragments ?? []).filter(
    (f) => !hidden.has(f.code)
  );

  /** Aplica una operación y muestra el resultado; devuelve si tuvo éxito. */
  function run(op: (d: CodedDocument) => EditResult, success: string): EditResult | null {
    if (!editing) return null;
    const res = editing.apply(op);
    setNotice(res.ok ? { kind: "info", text: success } : { kind: "error", text: res.reason });
    return res.ok ? res : null;
  }

  /** Al soltar el ratón sobre el texto en modo edición, interpreta la selección. */
  function onTextMouseUp() {
    skipClick.current = false;
    if (!editMode || !textRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = rangeToOffsets(sel.getRangeAt(0), textRef.current);
    if (!range) return;
    skipClick.current = true;

    if (adjusting) {
      const res = run(
        (d) => editFragment(d, adjusting, { start: range.start, end: range.end }),
        t("viewer.adjusted")
      );
      if (res?.ok && res.fragment) {
        setAdjusting(null);
        setActivePos(res.fragment.start);
      }
      sel.removeAllRanges();
      return;
    }

    setPending(range);
    setPendingLabel((prev) => (allowedLabels.includes(prev) ? prev : allowedLabels[0] ?? ""));
    setPendingJust("");
    setNotice(null);
  }

  /** Confirma el alta de un hallazgo con la selección pendiente. */
  function confirmAdd() {
    if (!pending || !pendingLabel) return;
    const res = run(
      (d) => addFragment(d, pending.start, pending.end, pendingLabel, pendingJust),
      t("viewer.added")
    );
    if (res?.ok && res.fragment) {
      setPending(null);
      setActivePos(res.fragment.start);
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(pendingLabel);
        return next;
      });
      window.getSelection()?.removeAllRanges();
    }
  }

  function change(f: Fragment, changes: FragmentChanges, success: string) {
    const res = run((d) => editFragment(d, f, changes), success);
    if (res?.ok && res.fragment) setActivePos(res.fragment.start);
  }

  function remove(f: Fragment) {
    if (!window.confirm(t("viewer.confirmRemove", { code: f.code, quote: shortQuote(f.quote, 80) }))) return;
    run((d) => removeFragment(d, f), t("viewer.removed"));
  }

  function toggleEditMode() {
    setEditMode((v) => !v);
    setPending(null);
    setAdjusting(null);
    setNotice(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div className="viewer">
      <div className="viewer-head">
        {canEdit && (
          <div className="edit-toolbar">
            <button
              className={editMode ? "button primary" : "button"}
              onClick={toggleEditMode}
            >
              {editMode ? t("viewer.finishEdit") : t("viewer.edit")}
            </button>
            {editMode && (
              <button
                className="button"
                disabled={!editing?.canUndo}
                onClick={() => {
                  editing?.undo();
                  setNotice({ kind: "info", text: t("viewer.undone") });
                }}
              >
                {t("viewer.undo")}
              </button>
            )}
          </div>
        )}
        <h3>{doc.name}</h3>
      </div>

      {editMode && (
        <p className={`edit-hint ${adjusting ? "adjusting" : ""}`}>
          {adjusting
            ? t("viewer.hintAdjust", { code: adjusting.code })
            : t("viewer.hintEdit")}
        </p>
      )}
      {editMode && notice && (
        <p className={notice.kind === "error" ? "error" : "edit-notice"}>{notice.text}</p>
      )}

      {/* Filtro de códigos con contador por código. */}
      <div className="viewer-filter">
        <span className="filter-label">{t("viewer.codes")}</span>
        {codesInDoc.map((label) => (
          <label key={label} className="filter-item">
            <input
              type="checkbox"
              checked={!hidden.has(label)}
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
          onClick={() => setHidden(allOn ? new Set(codesInDoc) : new Set())}
        >
          {allOn ? t("viewer.noneFilter") : t("viewer.allFilter")}
        </button>
      </div>

      {/* Panel FIJO: alta de un hallazgo o justificaciones del tramo seleccionado. */}
      <div className="justification-panel">
        {editMode && pending ? (
          <div className="add-form">
            <p className="add-quote">
              {t("viewer.newFinding")} “{shortQuote(doc.full_text.slice(pending.start, pending.end))}”
            </p>
            <div className="add-row">
              <label>
                {t("viewer.label")}{" "}
                <select value={pendingLabel} onChange={(e) => setPendingLabel(e.target.value)}>
                  {allowedLabels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <textarea
              rows={2}
              placeholder={t("viewer.justificationOptional")}
              value={pendingJust}
              onChange={(e) => setPendingJust(e.target.value)}
            />
            <div className="add-row">
              <button className="button primary" onClick={confirmAdd}>
                {t("viewer.add")}
              </button>
              <button className="button" onClick={() => setPending(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : activeFragments.length === 0 ? (
          <p className="justification-hint">{t("viewer.clickHint")}</p>
        ) : (
          <div className="justification-content">
            <ul className="justification-list">
              {activeFragments.map((f) => (
                <FragmentItem
                  key={`${f.start}-${f.end}-${f.code}`}
                  fragment={f}
                  fullText={doc.full_text}
                  color={colorOf.get(f.code) ?? "#999"}
                  ensembleModels={ensembleModels}
                  editMode={editMode}
                  allowedLabels={allowedLabels}
                  adjusting={adjusting === f}
                  onRelabel={(code) => change(f, { code }, t("viewer.relabeled"))}
                  onJustify={(justification) =>
                    change(f, { justification }, t("viewer.justificationSaved"))
                  }
                  onAdjust={() => {
                    setAdjusting(f);
                    setPending(null);
                    setNotice(null);
                  }}
                  onRemove={() => remove(f)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      <p
        ref={textRef}
        className={`viewer-text ${editMode ? "editing" : ""}`}
        onMouseUp={onTextMouseUp}
      >
        {segments.map((seg, i) => {
          const visible = seg.codes.filter((c) => !hidden.has(c));

          if (visible.length === 0) {
            // En edición: texto original plano con su offset para mapear la selección.
            return editMode ? (
              <span key={i} data-start={seg.start}>
                {seg.text}
              </span>
            ) : (
              <span key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(seg.text) }} />
            );
          }

          const isOverlap = visible.length > 1;
          const bg = isOverlap ? OVERLAP_COLOR : colorOf.get(visible[0]) ?? "#999";
          const isActive = activeSegment === seg;
          const props = {
            className: `hl ${isOverlap ? "overlap" : ""} ${isActive ? "active" : ""}`,
            style: { backgroundColor: bg + "66" },
            title: visible.join(" + "),
            onClick: () => {
              // Al terminar una selección sobre un resaltado no se cambia el panel.
              if (skipClick.current || window.getSelection()?.isCollapsed === false) {
                skipClick.current = false;
                return;
              }
              setActivePos(seg.start);
              setPending(null);
            },
          };

          return editMode ? (
            <mark key={i} data-start={seg.start} {...props}>
              {seg.text}
            </mark>
          ) : (
            <mark
              key={i}
              {...props}
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(seg.text) }}
            />
          );
        })}
      </p>
    </div>
  );
}

interface FragmentItemProps {
  fragment: Fragment;
  fullText: string;
  color: string;
  ensembleModels?: string[];
  editMode: boolean;
  allowedLabels: string[];
  adjusting: boolean;
  onRelabel: (code: string) => void;
  onJustify: (justification: string) => void;
  onAdjust: () => void;
  onRemove: () => void;
}

/** Un hallazgo en el panel: justificación, origen y, en edición, sus acciones. */
function FragmentItem({
  fragment: f,
  fullText,
  color,
  ensembleModels,
  editMode,
  allowedLabels,
  adjusting,
  onRelabel,
  onJustify,
  onAdjust,
  onRemove,
}: FragmentItemProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(f.justification);
  useEffect(() => setDraft(f.justification), [f.justification]);
  const origin = originOf(f);
  // Un JSON antiguo puede traer una etiqueta fuera del análisis: se muestra sin poder elegirla.
  const labels = allowedLabels.includes(f.code) ? allowedLabels : [f.code, ...allowedLabels];

  return (
    <li className={editMode ? "editable" : ""}>
      <div className="fragment-line">
        <span className="swatch" style={{ background: color }} />
        <strong>{f.code}:</strong>{" "}
        <span className={`origin-badge origin-${origin}`} title={t("viewer.originTitle")}>
          {t(ORIGIN_KEY[origin])}
        </span>{" "}
        {/* Acuerdo entre modelos (solo en consenso). */}
        {ensembleModels && f.models && f.models.length > 0 && (
          <span className="agreement-badge" title={t("viewer.agreed", { models: f.models.join(", ") })}>
            {f.models.length}/{ensembleModels.length}
          </span>
        )}{" "}
        {!editMode && (f.justification || <em>{t("viewer.noJustification")}</em>)}
      </div>

      {origin === "editado" && f.original && (
        <div className="original-note">
          {t("viewer.originalLlm")} [{f.original.code}] “
          {shortQuote(fullText.slice(f.original.start, f.original.end), 100)}”
        </div>
      )}

      {editMode && (
        <div className="fragment-edit">
          <p className="fragment-quote">“{shortQuote(f.quote, 200)}”</p>
          <label>
            {t("viewer.label")}{" "}
            <select value={f.code} onChange={(e) => onRelabel(e.target.value)}>
              {labels.map((l) => (
                <option key={l} value={l} disabled={!allowedLabels.includes(l)}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <textarea
            rows={2}
            placeholder={t("viewer.justification")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="add-row">
            <button
              className="button"
              disabled={draft.trim() === f.justification}
              onClick={() => onJustify(draft)}
            >
              {t("viewer.saveJustification")}
            </button>
            <button className={adjusting ? "button primary" : "button"} onClick={onAdjust}>
              {t("viewer.adjust")}
            </button>
            <button className="button danger" onClick={onRemove}>
              {t("viewer.remove")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
