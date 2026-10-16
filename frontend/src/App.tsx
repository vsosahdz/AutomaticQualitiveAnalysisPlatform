// Componente raíz: dos pestañas —"Analizar" (subir transcripciones y codificar)
// y "Cargar análisis" (visualizar JSON previamente exportados)—. Integra
// codebook, procesamiento con barra de progreso, selección de modelo y la vista
// de resultados reutilizable.
import { useEffect, useMemo, useState } from "react";
import type { Code, DocumentInput } from "./types";
import { seedCodebook } from "./codebook";
import { getModels } from "./api";
import { useJob } from "./useJob";
import { CodebookPanel } from "./components/CodebookPanel";
import { FileUpload } from "./components/FileUpload";
import { ResultsView } from "./components/ResultsView";
import { LoadAnalysis } from "./components/LoadAnalysis";
import { CompareView } from "./components/CompareView";

/** Estima el tamaño (en miles de millones de parámetros) desde el nombre. */
function estimateSize(name: string): number {
  const m = name.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  // Sin tamaño en el nombre → se considera "grande" para no elegirlo como rápido.
  return m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Elige el modelo por defecto recomendado: rápido pero con calidad decente.
 * Preferencia: qwen2.5:latest (7b) → el qwen más pequeño disponible → el
 * fallback del backend. Evita caer en modelos diminutos (p. ej. 1b) que son
 * rapidísimos pero imprecisos.
 */
function pickRecommended(models: string[], fallback: string): string {
  if (models.length === 0) return fallback;
  const preferred = models.find((m) => m.toLowerCase() === "qwen2.5:latest");
  if (preferred) return preferred;
  const qwen = models
    .filter((m) => m.toLowerCase().includes("qwen"))
    .sort((a, b) => estimateSize(a) - estimateSize(b));
  if (qwen.length) return qwen[0];
  return models.includes(fallback) ? fallback : models[0];
}

type Tab = "analizar" | "cargar" | "comparar";
type Theme = "light" | "dark";

export default function App() {
  // Pestaña activa de la aplicación.
  const [tab, setTab] = useState<Tab>("analizar");

  // Tema (claro/oscuro), persistido en localStorage y aplicado en <html>.
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("aqa-theme") as Theme) || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("aqa-theme", theme);
  }, [theme]);

  // Codebook en memoria, sembrado con los tres códigos base.
  const [codebook, setCodebook] = useState<Code[]>(() => seedCodebook());
  const [documents, setDocuments] = useState<DocumentInput[]>([]);
  const job = useJob();

  // Modelos de LLM disponibles y el seleccionado en el combo (modo un modelo).
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  // Mensaje de error si no se pueden cargar los modelos (vs "cargando…" eterno).
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Tipo de análisis y, en consenso, los modelos del ensamble (2–3).
  const [analysisType, setAnalysisType] = useState<"single" | "consensus">("single");
  const [consensusModels, setConsensusModels] = useState<string[]>([]);

  /** Marca/desmarca un modelo del ensamble (máximo 3). */
  function toggleConsensusModel(m: string) {
    setConsensusModels((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      if (prev.length >= 3) return prev; // máximo 3
      return [...prev, m];
    });
  }

  // Carga los modelos disponibles del backend al montar.
  useEffect(() => {
    getModels()
      .then((data) => {
        if (data.models.length === 0) {
          setModelsError(
            "No hay modelos disponibles. Verifica que Ollama esté en marcha y que " +
              "OLLAMA_HOST apunte a ese servidor (con los modelos descargados)."
          );
          return;
        }
        setModelsError(null);
        setModels(data.models);
        // Por defecto se selecciona un modelo rápido pero con calidad decente
        // (qwen 7b); la persona puede cambiar a uno más preciso (14b) en el combo.
        setModel(pickRecommended(data.models, data.default));
      })
      .catch(() => {
        setModelsError(
          "No se pudieron cargar los modelos (¿el backend/Ollama está en marcha? " +
            "Revisa OLLAMA_HOST)."
        );
      });
  }, []);

  // Solo se envían los códigos activos.
  const activeCodes = useMemo(
    () => codebook.filter((c) => c.active),
    [codebook]
  );

  const busy = job.state === "pending" || job.state === "running";
  // En consenso se requieren 2–3 modelos seleccionados.
  const consensusReady =
    analysisType === "single" ||
    (consensusModels.length >= 2 && consensusModels.length <= 3);
  const canProcess =
    documents.length > 0 && activeCodes.length > 0 && consensusReady && !busy;
  const result = job.result;

  /** Dispara el procesamiento según el tipo de análisis elegido. */
  function handleProcess() {
    if (analysisType === "consensus") {
      job.run({ documents, codebook: activeCodes, models: consensusModels });
    } else {
      job.run({ documents, codebook: activeCodes, model: model || undefined });
    }
  }

  return (
    <div className="app">
      <header>
        <div className="header-top">
          <div>
            <h1>Análisis Cualitativo Automático</h1>
            <p className="subtitle">
              Codificación asistida por LLM para investigación en sistemas alimentarios
            </p>
          </div>
          {/* Toggle de modo oscuro. */}
          <button
            className="theme-toggle"
            title={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀️ Claro" : "🌙 Oscuro"}
          </button>
        </div>
        {/* Pestañas principales */}
        <nav className="tabs">
          <button
            className={tab === "analizar" ? "active" : ""}
            onClick={() => setTab("analizar")}
          >
            Analizar
          </button>
          <button
            className={tab === "cargar" ? "active" : ""}
            onClick={() => setTab("cargar")}
          >
            Cargar análisis
          </button>
          <button
            className={tab === "comparar" ? "active" : ""}
            onClick={() => setTab("comparar")}
          >
            Comparar
          </button>
        </nav>
      </header>

      {tab === "cargar" ? (
        <LoadAnalysis />
      ) : tab === "comparar" ? (
        <CompareView />
      ) : (
        <div className="layout">
          {/* Columna izquierda: configuración de la corrida */}
          <aside>
            <FileUpload documents={documents} onChange={setDocuments} />
            <CodebookPanel codebook={codebook} onChange={setCodebook} />
          </aside>

          {/* Columna derecha: acción y resultados */}
          <main>
            <div className="panel run-panel">
              {/* Tipo de análisis: un solo modelo o consenso (ensamble). */}
              <div className="analysis-type">
                <span className="group-label">Tipo de análisis:</span>
                <label>
                  <input
                    type="radio"
                    name="analysis-type"
                    checked={analysisType === "single"}
                    disabled={busy}
                    onChange={() => setAnalysisType("single")}
                  />
                  Un modelo
                </label>
                <label>
                  <input
                    type="radio"
                    name="analysis-type"
                    checked={analysisType === "consensus"}
                    disabled={busy}
                    onChange={() => setAnalysisType("consensus")}
                  />
                  Consenso (2–3 modelos)
                </label>
              </div>

              {analysisType === "single" ? (
                <label className="model-select">
                  Modelo LLM:
                  <select
                    value={model}
                    disabled={busy || models.length === 0}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {models.length === 0 && (
                      <option value="">
                        {modelsError ? "(sin modelos)" : "(cargando…)"}
                      </option>
                    )}
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="consensus-models">
                  <span className="group-label">
                    Modelos del ensamble ({consensusModels.length}/3):
                  </span>
                  <div className="model-checks">
                    {models.map((m) => {
                      const checked = consensusModels.includes(m);
                      const atMax = consensusModels.length >= 3 && !checked;
                      return (
                        <label key={m} className={atMax ? "disabled" : ""}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || atMax}
                            onChange={() => toggleConsensusModel(m)}
                          />
                          {m}
                        </label>
                      );
                    })}
                  </div>
                  {models.length === 0 && !modelsError && (
                    <p className="hint">Cargando modelos…</p>
                  )}
                  {consensusModels.length < 2 && models.length > 0 && (
                    <p className="hint">Selecciona al menos 2 modelos.</p>
                  )}
                </div>
              )}

              {modelsError && <p className="error">{modelsError}</p>}

              <div className="run-buttons">
                <button
                  className="primary big"
                  disabled={!canProcess}
                  onClick={handleProcess}
                >
                  {busy ? "Procesando…" : "▶ Procesar"}
                </button>
                {busy && (
                  <button className="danger big" onClick={job.cancel}>
                    ✕ Cancelar
                  </button>
                )}
              </div>

              {job.state === "cancelled" && (
                <p className="meta">Procesamiento cancelado.</p>
              )}

              {busy && (
                <div className="progress">
                  <div
                    className="progress-bar"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                  />
                  <span className="progress-label">
                    {Math.round(job.progress * 100)}% · {job.message}
                  </span>
                </div>
              )}

              {job.state === "error" && (
                <p className="error">Error: {job.error}</p>
              )}
            </div>

            {result && result.documents.length > 0 && (
              <ResultsView
                result={result}
                codebook={codebook}
                jobId={job.jobId}
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}
