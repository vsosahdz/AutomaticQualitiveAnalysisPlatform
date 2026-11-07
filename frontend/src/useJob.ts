// Hook que encapsula el ciclo de vida de un trabajo de codificación:
// enviar POST /process, hacer polling del progreso y recuperar el resultado.
import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  cancelJob,
  getJobResult,
  getJobStatus,
  POLL_INTERVAL_MS,
  startProcessing,
} from "./api";
import type { JobState, ProcessRequest, Result } from "./types";

/** Estado expuesto por el hook useJob. */
export interface UseJob {
  state: JobState | "idle";
  progress: number;
  message: string;
  result: Result | null;
  jobId: string | null;
  error: string | null;
  /** Inicia un trabajo con la petición dada. */
  run: (request: ProcessRequest) => Promise<void>;
  /** Solicita cancelar el trabajo en curso. */
  cancel: () => Promise<void>;
  /** Reinicia el estado del hook. */
  reset: () => void;
}

export function useJob(): UseJob {
  const [state, setState] = useState<JobState | "idle">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Referencia al timer de polling para poder cancelarlo.
  const timer = useRef<number | null>(null);

  /** Detiene cualquier polling en curso. */
  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setState("idle");
    setProgress(0);
    setMessage("");
    setResult(null);
    setJobId(null);
    setError(null);
  }, [stopPolling]);

  /** Hace polling recursivo del estado hasta done/error. */
  const poll = useCallback(
    (id: string) => {
      timer.current = window.setTimeout(async () => {
        try {
          const status = await getJobStatus(id);
          setState(status.state);
          setProgress(status.progress);
          setMessage(status.message);

          if (status.state === "done") {
            const res = await getJobResult(id);
            setResult(res);
            return; // termina el polling
          }
          if (status.state === "error") {
            setError(status.error ?? "Error desconocido");
            return;
          }
          if (status.state === "cancelled") {
            return; // trabajo cancelado: termina el polling
          }
          poll(id); // sigue consultando
        } catch (err) {
          const msg =
            err instanceof ApiError ? err.message : "Error de red al consultar el trabajo";
          setError(msg);
          setState("error");
        }
      }, POLL_INTERVAL_MS);
    },
    []
  );

  const run = useCallback(
    async (request: ProcessRequest) => {
      reset();
      setState("pending");
      try {
        const id = await startProcessing(request);
        setJobId(id);
        poll(id);
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : "No se pudo iniciar el procesamiento";
        setError(msg);
        setState("error");
      }
    },
    [poll, reset]
  );

  /** Solicita cancelar el trabajo en curso y detiene el polling. */
  const cancel = useCallback(async () => {
    if (!jobId) return;
    stopPolling();
    setMessage("Cancelando…");
    try {
      await cancelJob(jobId);
    } catch {
      // Ignora errores de red al cancelar: el estado se refleja igualmente.
    }
    setState("cancelled");
    setMessage("Cancelado");
  }, [jobId, stopPolling]);

  return { state, progress, message, result, jobId, error, run, cancel, reset };
}
