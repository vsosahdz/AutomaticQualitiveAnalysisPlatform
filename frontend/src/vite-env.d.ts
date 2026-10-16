/// <reference types="vite/client" />

// Tipado de las variables de entorno expuestas por Vite (prefijo VITE_).
interface ImportMetaEnv {
  /** Base URL de la API del backend (p. ej. "/api" o "https://host"). */
  readonly VITE_API_BASE_URL?: string;
  /** Intervalo de polling del progreso en ms. */
  readonly VITE_POLL_INTERVAL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
