// Formulario para agregar o editar un código: nombre, definición, ejemplos
// few-shot opcionales y color. Valida antes de guardar.
import { useState } from "react";
import type { Code, FewShotExample } from "../types";
import { validateCode } from "../codebook";

interface CodeFormProps {
  /** Código a editar; si es undefined, es un alta nueva. */
  editing?: Code;
  /** Codebook actual (para validar unicidad del nombre). */
  codebook: Code[];
  /** Color sugerido para un alta nueva. */
  suggestedColor: string;
  /** Guarda el código (alta o edición). */
  onSave: (code: Code) => void;
  /** Cancela el formulario. */
  onCancel: () => void;
}

/** Deriva un id estable a partir de la etiqueta (kebab, sin acentos). */
function toId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function CodeForm({
  editing,
  codebook,
  suggestedColor,
  onSave,
  onCancel,
}: CodeFormProps) {
  const isBase = editing?.origin === "base";
  const [label, setLabel] = useState(editing?.label ?? "");
  const [definition, setDefinition] = useState(editing?.definition ?? "");
  const [color, setColor] = useState(editing?.color ?? suggestedColor);
  const [examples, setExamples] = useState<FewShotExample[]>(
    editing?.examples ?? []
  );
  const [error, setError] = useState<string | undefined>();

  /** Añade un ejemplo few-shot vacío del tipo indicado. */
  function addExample(kind: FewShotExample["kind"]) {
    setExamples((prev) => [...prev, { text: "", kind }]);
  }

  /** Actualiza el texto de un ejemplo por índice. */
  function updateExample(index: number, text: string) {
    setExamples((prev) =>
      prev.map((e, i) => (i === index ? { ...e, text } : e))
    );
  }

  /** Elimina un ejemplo por índice. */
  function removeExample(index: number) {
    setExamples((prev) => prev.filter((_, i) => i !== index));
  }

  /** Valida y emite el código al guardar. */
  function handleSave() {
    // La validación de nombre/definición aplica a custom; los base solo editan
    // definición (el nombre no cambia).
    if (!isBase) {
      const v = validateCode(label, definition, codebook, editing?.id);
      if (!v.ok) {
        setError(v.error);
        return;
      }
    } else if (!definition.trim()) {
      setError("La definición no puede quedar vacía.");
      return;
    }

    const cleanedExamples = examples
      .map((e) => ({ ...e, text: e.text.trim() }))
      .filter((e) => e.text.length > 0);

    const code: Code = {
      id: editing?.id ?? toId(label),
      label: isBase ? editing!.label : label.trim(),
      definition: definition.trim(),
      examples: cleanedExamples,
      color,
      origin: editing?.origin ?? "custom",
      active: editing?.active ?? true,
    };
    onSave(code);
  }

  return (
    <div className="code-form">
      <h3>{editing ? "Editar código" : "Nuevo código"}</h3>

      <label>
        Nombre
        <input
          type="text"
          value={label}
          disabled={isBase}
          placeholder="p. ej. Gobernanza"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      <label>
        Definición
        <textarea
          value={definition}
          rows={5}
          placeholder="Qué es · qué efecto tiene · en qué se diferencia de conceptos vecinos · ejemplos"
          onChange={(e) => setDefinition(e.target.value)}
        />
      </label>
      <p className="hint">
        💡 Una buena definición dice: <strong>qué es</strong>,{" "}
        <strong>qué efecto tiene</strong>, <strong>en qué se diferencia</strong>{" "}
        de conceptos vecinos y da <strong>ejemplos</strong>.
      </p>

      <fieldset className="examples">
        <legend>Ejemplos few-shot (opcional)</legend>
        {examples.map((ex, i) => (
          <div key={i} className="example-row">
            <span className={`badge ${ex.kind}`}>
              {ex.kind === "positive" ? "✓ Sí" : "✗ No"}
            </span>
            <input
              type="text"
              value={ex.text}
              placeholder="ejemplo…"
              onChange={(e) => updateExample(i, e.target.value)}
            />
            <button type="button" onClick={() => removeExample(i)}>
              ✕
            </button>
          </div>
        ))}
        <div className="example-actions">
          <button type="button" onClick={() => addExample("positive")}>
            ＋ Ejemplo positivo
          </button>
          <button type="button" onClick={() => addExample("negative")}>
            ＋ Ejemplo negativo
          </button>
        </div>
      </fieldset>

      <label className="color-field">
        Color
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </label>

      {error && <p className="error">{error}</p>}

      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="primary" onClick={handleSave}>
          Guardar
        </button>
      </div>
    </div>
  );
}
