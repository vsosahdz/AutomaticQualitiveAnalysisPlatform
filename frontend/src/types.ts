// Tipos TypeScript espejo de los contratos del backend (app/models).
// Mantenerlos alineados con Pydantic evita sorpresas en la (de)serialización.

/** Origen de un código: base (fijo) o custom (añadido por la persona usuaria). */
export type CodeOrigin = "base" | "custom";

/** Tipo de un ejemplo few-shot. */
export type ExampleKind = "positive" | "negative";

/** Ejemplo few-shot opcional adjunto a un código. */
export interface FewShotExample {
  text: string;
  kind: ExampleKind;
}

/** Un código del codebook. Coincide con app/models/code.py:Code. */
export interface Code {
  id: string;
  label: string;
  definition: string;
  examples: FewShotExample[];
  color: string;
  origin: CodeOrigin;
  active: boolean;
}

/** Un documento de entrada (nombre + contenido de la transcripción). */
export interface DocumentInput {
  name: string;
  content: string;
}

/** Cuerpo de POST /process. */
export interface ProcessRequest {
  documents: DocumentInput[];
  codebook: Code[];
  /** Modelo único (análisis de un solo modelo). */
  model?: string;
  /** Lista de 2–3 modelos (análisis por consenso). */
  models?: string[];
}

/** Respuesta de GET /models: modelos disponibles y el default. */
export interface ModelsResponse {
  models: string[];
  default: string;
}

/** Un fragmento codificado con offsets exactos sobre el texto original. */
export interface Fragment {
  start: number;
  end: number;
  code: string;
  quote: string;
  justification: string;
  /** Modelos que coincidieron (solo en análisis por consenso). */
  models?: string[];
}

/** Un documento codificado. */
export interface CodedDocument {
  name: string;
  full_text: string;
  fragments: Fragment[];
  /** Segundos que tomó codificar este documento. */
  elapsed_seconds?: number;
}

/** Registro de una salida del LLM descartada por inválida. */
export interface Dropped {
  document: string;
  reason: string;
  raw: string;
}

/** Resultado JSON rico de un trabajo (fuente única de verdad). */
export interface Result {
  documents: CodedDocument[];
  dropped: Dropped[];
  /** Segundos totales del trabajo. */
  total_seconds?: number;
  /** Tipo de análisis: "single" o "consensus". */
  analysis_type?: string;
  /** Modelos usados (ensamble en consenso). */
  models?: string[];
}

// --- Fase II: comparación humano vs LLM ---

/** Métricas léxicas de un código. */
export interface CodeMetric {
  code: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  kappa: number | null;
}

/** Métricas globales. */
export interface OverallMetrics {
  precision: number;
  recall: number;
  f1: number;
  kappa: number | null;
}

/** Diff por oración. */
export interface UnitDiff {
  start: number;
  end: number;
  text: string;
  human: string[];
  llm: string[];
  status: "agree" | "only_human" | "only_llm" | "partial" | "none";
}

/** Fragmento con su similitud semántica máxima al otro lado. */
export interface FragmentSim {
  code: string;
  quote: string;
  start: number;
  end: number;
  max_similarity: number;
  justification: string;
  comment: string;
  best_match_quote: string;
  best_match_code: string;
}

/** Comparación de un documento. */
export interface DocumentComparison {
  name: string;
  full_text: string;
  units: UnitDiff[];
  per_code: CodeMetric[];
  overall: OverallMetrics;
  llm_fragments: FragmentSim[];
  human_fragments: FragmentSim[];
}

/** Resumen de la codificación humana: cuántas citas por código. */
export interface HumanSummary {
  by_code: Record<string, number>;
  total: number;
  documents: string[];
}

/** Resultado completo de la comparación. */
export interface ComparisonResult {
  documents: DocumentComparison[];
  embedding_model: string;
  default_threshold: number;
  unmapped: string[];
}

/** Estados posibles de un trabajo. */
export type JobState = "pending" | "running" | "done" | "error" | "cancelled";

/** Estado y progreso de un trabajo (GET /jobs/{id}). */
export interface JobStatus {
  job_id: string;
  state: JobState;
  progress: number;
  message: string;
  error: string | null;
}
