// Cliente HTTP del backend. La base URL y el intervalo de polling se leen de
// variables de entorno (VITE_*) para funcionar en local o en la nube.
import type {
  CodedDocument,
  ComparisonResult,
  HumanSummary,
  JobStatus,
  ModelsResponse,
  ProcessRequest,
  Result,
} from "./types";

/** Base URL de la API (proxy "/api" por defecto en desarrollo). */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

/** Intervalo de polling del progreso en ms (1500 por defecto). */
export const POLL_INTERVAL_MS = Number(
  import.meta.env.VITE_POLL_INTERVAL_MS ?? "1500"
);

/** Error de API con el código de estado HTTP para manejo diferenciado. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Lee el detalle de error de una respuesta fallida, con fallback razonable. */
async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.detail === "string" ? data.detail : res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Encola un trabajo de codificación.
 * @returns el job_id del trabajo creado.
 */
export async function startProcessing(request: ProcessRequest): Promise<string> {
  const res = await fetch(`${API_BASE}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  const data = (await res.json()) as { job_id: string };
  return data.job_id;
}

/** Solicita cancelar un trabajo en curso (cancelación cooperativa). */
export async function cancelJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/cancel`, { method: "POST" });
  // 404/422 se ignoran: el trabajo pudo haber terminado justo antes de cancelar.
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    throw new ApiError(res.status, await readError(res));
  }
}

/** Consulta el estado/progreso de un trabajo. */
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as JobStatus;
}

/** Obtiene el resultado JSON rico de un trabajo terminado. */
export async function getJobResult(jobId: string): Promise<Result> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/result`);
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as Result;
}

/** Construye la URL de descarga del CSV combinado de un trabajo. */
export function csvUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/csv`;
}

/** Construye la URL del ZIP con un CSV por documento (CSV separados). */
export function csvZipUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/csv.zip`;
}

/** Obtiene los modelos disponibles y el modelo por defecto. */
export async function getModels(): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/models`);
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as ModelsResponse;
}

/**
 * Compara la codificación del LLM contra la humana (Fase II).
 * @param llmDocs documentos codificados por el LLM (texto + fragmentos)
 * @param humanFile archivo CSV/XLSX con la codificación humana
 */
export async function compareCodings(
  llmDocs: CodedDocument[],
  humanFile: File
): Promise<ComparisonResult> {
  const form = new FormData();
  form.append("llm", JSON.stringify(llmDocs));
  form.append("human_file", humanFile);
  const res = await fetch(`${API_BASE}/compare`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as ComparisonResult;
}

/** Cuantifica las citas por código de un archivo de codificación humana. */
export async function humanSummary(humanFile: File): Promise<HumanSummary> {
  const form = new FormData();
  form.append("human_file", humanFile);
  const res = await fetch(`${API_BASE}/human/summary`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as HumanSummary;
}

/** Genera el reporte DOCX de hallazgos solo-IA y devuelve el Blob. */
export async function reportDocx(payload: unknown): Promise<Blob> {
  const res = await fetch(`${API_BASE}/report/docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return await res.blob();
}
