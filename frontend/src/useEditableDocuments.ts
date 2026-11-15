// Estado editable de un conjunto de documentos codificados, con deshacer por
// documento y una bandera de ediciones sin exportar.
import { useCallback, useEffect, useState } from "react";
import type { CodedDocument } from "./types";
import type { EditResult } from "./editing";
import { t } from "./i18n";

interface State {
  docs: CodedDocument[];
  /** Pila de versiones anteriores por nombre de documento (la última, arriba). */
  history: Record<string, CodedDocument[]>;
  /** Hay ediciones posteriores a la última exportación. */
  dirty: boolean;
}

const EMPTY: State = { docs: [], history: {}, dirty: false };

export interface EditableDocuments {
  docs: CodedDocument[];
  dirty: boolean;
  /** Reemplaza todos los documentos (nuevo análisis); olvida historial y ediciones. */
  setAll: (docs: CodedDocument[]) => void;
  /** Agrega o reemplaza documentos por nombre, conservando los demás y su historial. */
  upsert: (docs: CodedDocument[]) => void;
  /**
   * Aplica una operación de edición al documento indicado.
   * @returns el resultado de la operación (con el motivo si se rechazó)
   */
  apply: (name: string, op: (doc: CodedDocument) => EditResult) => EditResult;
  undo: (name: string) => void;
  canUndo: (name: string) => boolean;
  /** Marca las ediciones como exportadas. */
  markClean: () => void;
}

export function useEditableDocuments(): EditableDocuments {
  const [state, setState] = useState<State>(EMPTY);

  // Con ediciones sin exportar, el navegador pide confirmación al cerrar la página.
  useEffect(() => {
    if (!state.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state.dirty]);

  const setAll = useCallback((docs: CodedDocument[]) => {
    setState({ docs, history: {}, dirty: false });
  }, []);

  const upsert = useCallback((incoming: CodedDocument[]) => {
    setState((prev) => {
      const byName = new Map(prev.docs.map((d) => [d.name, d]));
      const history = { ...prev.history };
      for (const d of incoming) {
        byName.set(d.name, d);
        delete history[d.name]; // un documento recargado empieza sin historial
      }
      return { ...prev, docs: Array.from(byName.values()), history };
    });
  }, []);

  const apply = useCallback(
    (name: string, op: (doc: CodedDocument) => EditResult): EditResult => {
      const current = state.docs.find((d) => d.name === name);
      if (!current) return { ok: false, reason: t("edit.docNotFound") };
      const result = op(current);
      if (!result.ok || result.doc === current) return result;
      setState((prev) => ({
        docs: prev.docs.map((d) => (d.name === name ? result.doc : d)),
        history: { ...prev.history, [name]: [...(prev.history[name] ?? []), current] },
        dirty: true,
      }));
      return result;
    },
    [state.docs]
  );

  const undo = useCallback((name: string) => {
    setState((prev) => {
      const stack = prev.history[name] ?? [];
      if (stack.length === 0) return prev;
      const previous = stack[stack.length - 1];
      return {
        docs: prev.docs.map((d) => (d.name === name ? previous : d)),
        history: { ...prev.history, [name]: stack.slice(0, -1) },
        dirty: true,
      };
    });
  }, []);

  const canUndo = useCallback(
    (name: string) => (state.history[name]?.length ?? 0) > 0,
    [state.history]
  );

  const markClean = useCallback(() => {
    setState((prev) => ({ ...prev, dirty: false }));
  }, []);

  return {
    docs: state.docs,
    dirty: state.dirty,
    setAll,
    upsert,
    apply,
    undo,
    canUndo,
    markClean,
  };
}
