// Operaciones de edición de hallazgos sobre un documento codificado.
//
// Son funciones puras: reciben un documento y devuelven uno nuevo (o un error),
// sin mutar el original, para que deshacer sea guardar el documento anterior.
// Los fragmentos se identifican por referencia: una operación conserva los
// objetos de los fragmentos que no toca y crea uno nuevo para el que modifica.
import type { CodedDocument, Fragment, FragmentOrigin } from "./types";
import { t } from "./i18n";

/** Resultado de una operación de edición. */
export type EditResult =
  | { ok: true; doc: CodedDocument; fragment?: Fragment }
  | { ok: false; reason: string };

/** Cambios aplicables a un fragmento existente. */
export interface FragmentChanges {
  start?: number;
  end?: number;
  code?: string;
  justification?: string;
}

/** Origen efectivo de un fragmento (los JSON antiguos no traen el campo). */
export function originOf(f: Fragment): FragmentOrigin {
  return f.origin ?? "llm";
}

/**
 * Recorta los espacios en blanco de los extremos del tramo [start, end).
 * @returns el tramo recortado, o null si no queda texto.
 */
export function trimRange(
  text: string,
  start: number,
  end: number
): { start: number; end: number } | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(text.length, Math.max(start, end));
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return s < e ? { start: s, end: e } : null;
}

/** Texto corto para identificar un fragmento en un mensaje de error. */
function describe(f: Fragment): string {
  const q = f.quote.length > 60 ? f.quote.slice(0, 57) + "…" : f.quote;
  return `${f.code}: “${q}”`;
}

/**
 * Valida un tramo para un código: dentro del texto, no vacío y sin solaparse con
 * otro fragmento del MISMO código (los solapes entre códigos distintos se permiten).
 *
 * @param ignore fragmento que se está editando (no cuenta como choque consigo mismo)
 * @returns un mensaje de error, o null si es válido
 */
export function validateRange(
  doc: CodedDocument,
  start: number,
  end: number,
  code: string,
  ignore?: Fragment
): string | null {
  if (start < 0 || end > doc.full_text.length || start >= end) {
    return t("edit.invalidRange");
  }
  const clash = doc.fragments.find(
    (f) => f !== ignore && f.code === code && f.start < end && start < f.end
  );
  if (clash) {
    return t("edit.overlap", { fragment: describe(clash) });
  }
  return null;
}

/** Ordena los fragmentos por posición, como el resultado del backend. */
function sortFragments(fragments: Fragment[]): Fragment[] {
  return [...fragments].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code)
  );
}

/** Agrega un hallazgo manual en el tramo indicado (se recortan espacios). */
export function addFragment(
  doc: CodedDocument,
  start: number,
  end: number,
  code: string,
  justification = ""
): EditResult {
  const range = trimRange(doc.full_text, start, end);
  if (!range) return { ok: false, reason: t("edit.emptySelection") };
  const error = validateRange(doc, range.start, range.end, code);
  if (error) return { ok: false, reason: error };
  const fragment: Fragment = {
    start: range.start,
    end: range.end,
    code,
    quote: doc.full_text.slice(range.start, range.end),
    justification: justification.trim(),
    origin: "manual",
  };
  return {
    ok: true,
    doc: { ...doc, fragments: sortFragments([...doc.fragments, fragment]) },
    fragment,
  };
}

/**
 * Modifica un fragmento existente (extensión, etiqueta y/o justificación).
 * Un fragmento "llm" pasa a "editado" y guarda sus valores originales; uno
 * "editado" o "manual" conserva su origen.
 */
export function editFragment(
  doc: CodedDocument,
  target: Fragment,
  changes: FragmentChanges
): EditResult {
  if (!doc.fragments.includes(target)) {
    return { ok: false, reason: t("edit.gone") };
  }
  let start = changes.start ?? target.start;
  let end = changes.end ?? target.end;
  if (changes.start !== undefined || changes.end !== undefined) {
    const range = trimRange(doc.full_text, start, end);
    if (!range) return { ok: false, reason: t("edit.emptySelection") };
    ({ start, end } = range);
  }
  const code = changes.code ?? target.code;
  const justification =
    changes.justification !== undefined ? changes.justification.trim() : target.justification;

  // Sin cambios reales: no se altera el documento ni el origen.
  if (
    start === target.start &&
    end === target.end &&
    code === target.code &&
    justification === target.justification
  ) {
    return { ok: true, doc, fragment: target };
  }

  const error = validateRange(doc, start, end, code, target);
  if (error) return { ok: false, reason: error };

  const origin = originOf(target);
  const fragment: Fragment = {
    ...target,
    start,
    end,
    code,
    justification,
    quote: doc.full_text.slice(start, end),
    origin: origin === "llm" ? "editado" : origin,
    original:
      origin === "llm"
        ? {
            start: target.start,
            end: target.end,
            code: target.code,
            justification: target.justification,
          }
        : target.original ?? null,
  };
  return {
    ok: true,
    doc: {
      ...doc,
      fragments: sortFragments(doc.fragments.map((f) => (f === target ? fragment : f))),
    },
    fragment,
  };
}

/**
 * Elimina un fragmento. Los de origen "llm" o "editado" se conservan en
 * ``removed_fragments`` para poder cuantificar la corrección; los "manual" se descartan.
 */
export function removeFragment(doc: CodedDocument, target: Fragment): EditResult {
  if (!doc.fragments.includes(target)) {
    return { ok: false, reason: t("edit.gone") };
  }
  const keep = originOf(target) !== "manual";
  return {
    ok: true,
    doc: {
      ...doc,
      fragments: doc.fragments.filter((f) => f !== target),
      removed_fragments: keep
        ? [...(doc.removed_fragments ?? []), target]
        : doc.removed_fragments ?? [],
    },
  };
}

/** Indica si el documento tiene ediciones de una persona. */
export function isEdited(doc: CodedDocument): boolean {
  return (
    (doc.removed_fragments?.length ?? 0) > 0 ||
    doc.fragments.some((f) => originOf(f) !== "llm")
  );
}
