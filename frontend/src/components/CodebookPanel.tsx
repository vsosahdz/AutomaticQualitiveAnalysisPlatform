// Panel del codebook: lista los códigos como tarjetas con color, definición,
// estado y acciones (editar, activar/desactivar, restaurar base, borrar custom).
import { useState } from "react";
import type { Code } from "../types";
import {
  activeBaseCount,
  baseDefinition,
  canAddCustom,
  canDeactivate,
  customCount,
  MAX_CUSTOM_CODES,
  pickColor,
} from "../codebook";
import { CodeForm } from "./CodeForm";
import { useI18n } from "../i18n";

interface CodebookPanelProps {
  codebook: Code[];
  onChange: (codebook: Code[]) => void;
}

export function CodebookPanel({ codebook, onChange }: CodebookPanelProps) {
  const { t } = useI18n();
  // Estado del formulario: 'closed' | 'new' | el código en edición.
  const [form, setForm] = useState<"closed" | "new" | Code>("closed");

  /** Alta o actualización de un código en el codebook. */
  function upsert(code: Code) {
    const exists = codebook.some((c) => c.id === code.id);
    onChange(
      exists
        ? codebook.map((c) => (c.id === code.id ? code : c))
        : [...codebook, code]
    );
    setForm("closed");
  }

  /** Activa/desactiva un código respetando la regla de ≥1 base activo. */
  function toggleActive(code: Code) {
    if (code.active && !canDeactivate(codebook, code)) return;
    onChange(
      codebook.map((c) => (c.id === code.id ? { ...c, active: !c.active } : c))
    );
  }

  /** Borra un código custom. */
  function remove(code: Code) {
    onChange(codebook.filter((c) => c.id !== code.id));
  }

  /** Restaura la definición semilla original de un código base. */
  function restore(code: Code) {
    const def = baseDefinition(code.id);
    if (def === undefined) return;
    onChange(
      codebook.map((c) => (c.id === code.id ? { ...c, definition: def } : c))
    );
  }

  if (form !== "closed") {
    return (
      <div className="panel">
        <CodeForm
          editing={form === "new" ? undefined : form}
          codebook={codebook}
          suggestedColor={pickColor(codebook)}
          onSave={upsert}
          onCancel={() => setForm("closed")}
        />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{t("codebook.title")}</h2>
        <button
          className="primary"
          disabled={!canAddCustom(codebook)}
          title={
            canAddCustom(codebook)
              ? t("codebook.addTitle")
              : t("codebook.maxCustom", { n: MAX_CUSTOM_CODES })
          }
          onClick={() => setForm("new")}
        >
          {t("codebook.add")}
        </button>
      </div>

      <p className="meta">
        {t("codebook.summary", {
          base: activeBaseCount(codebook),
          custom: customCount(codebook),
          max: MAX_CUSTOM_CODES,
        })}
      </p>

      <ul className="code-list">
        {codebook.map((code) => (
          <li
            key={code.id}
            className={`code-card ${code.active ? "" : "inactive"}`}
          >
            <div className="code-head">
              <span className="swatch" style={{ background: code.color }} />
              <strong>{code.label}</strong>
              <span className={`tag ${code.origin}`}>{code.origin}</span>
            </div>
            <p className="code-def">{code.definition}</p>
            {code.examples.length > 0 && (
              <p className="code-examples">
                {t("codebook.examples", { n: code.examples.length })}
              </p>
            )}
            <div className="code-actions">
              <button onClick={() => setForm(code)}>{t("common.edit")}</button>
              <button
                onClick={() => toggleActive(code)}
                disabled={code.active && !canDeactivate(codebook, code)}
                title={
                  code.active && !canDeactivate(codebook, code)
                    ? t("codebook.keepOneBase")
                    : ""
                }
              >
                {code.active ? t("codebook.deactivate") : t("codebook.activate")}
              </button>
              {code.origin === "base" ? (
                <button onClick={() => restore(code)}>{t("codebook.restore")}</button>
              ) : (
                <button className="danger" onClick={() => remove(code)}>
                  {t("codebook.delete")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
