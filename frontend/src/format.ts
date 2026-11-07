// Utilidades de formato para la interfaz.

/**
 * Formatea una duración en segundos de forma legible.
 * Ej.: 8.4 → "8.4 s"; 75 → "1 min 15 s".
 */
export function formatSeconds(seconds?: number): string {
  if (seconds === undefined || seconds < 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const min = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${min} min ${rest} s`;
}
