// Lógica del codebook en el frontend: semilla de códigos base, paleta de colores
// y reglas de validación. El codebook vive en memoria (sin persistencia) y se
// envía completo en cada petición.
import type { Code } from "./types";

/** Máximo de códigos custom (espejo de MAX_CUSTOM_CODES del backend). */
export const MAX_CUSTOM_CODES = 3;

/** Colores fijos de los tres códigos base. */
const BASE_COLORS: Record<string, string> = {
  barrera: "#E4572E",
  facilitador: "#2E933C",
  estrategia: "#3A6EA5",
};

/** Paleta para autoasignar color a códigos custom. */
export const CUSTOM_PALETTE = [
  "#7B4FA3",
  "#C9A227",
  "#0FA3B1",
  "#D7263D",
  "#5C6672",
];

// Definiciones semilla de los tres códigos base (verbatim del proyecto).
const BASE_DEFINITIONS: Record<string, string> = {
  barrera:
    "Una barrera es cualquier condición, situación o factor que dificulta o impide que una iniciativa funcione adecuadamente, se sostenga en el tiempo, desarrolle sus actividades o logre sus objetivos, afectando de manera negativa sus procesos, resultados o continuidad, por ejemplo, la pérdida de conocimiento, las trabas burocráticas, el calor, la erosión del suelo. Se diferencian de los problemas que la iniciativa busca resolver, ya que estos no necesariamente afectan directamente su funcionamiento interno.",
  facilitador:
    "Un facilitador es cualquier condición, recurso, relación o aspecto del contexto que, de manera pasiva, contribuye a que una iniciativa pueda avanzar, operar, sostenerse en el tiempo y cumplir sus objetivos con mayor facilidad, al reducir barreras y simplificar procesos sin requerir esfuerzos adicionales significativos ni el desarrollo de nuevas estrategias; se trata de factores ya existentes o que se dan naturalmente y que actúan como soporte indirecto, idealmente replicables y accionables en otros contextos, como el acceso a contactos que permiten el uso de recursos, y que se distinguen de las oportunidades —que implican situaciones externas que deben aprovecharse estratégicamente— y de las casualidades —que son eventos fortuitos no estructurales.",
  estrategia:
    "Es una acción que una iniciativa realiza de manera activa y deliberada para superar obstáculos, resolver problemas, lograr resultados esperados, cumplir sus objetivos o sostener su trabajo en el tiempo; implica decisiones pensadas y organizadas que responden a necesidades concretas, como crear alianzas con otros actores, desarrollar formas de comunicación ante situaciones específicas, reorganizarse frente a dificultades. Se caracteriza por surgir de la intención y la planificación de la propia iniciativa, no de factores externos, casualidades o acciones de terceros.",
};

/** Etiquetas visibles de los códigos base. */
const BASE_LABELS: Record<string, string> = {
  barrera: "Barrera",
  facilitador: "Facilitador",
  estrategia: "Estrategia",
};

/**
 * Construye el codebook inicial con los tres códigos base activos.
 * Se llama una vez al iniciar la sesión.
 */
export function seedCodebook(): Code[] {
  return (["barrera", "facilitador", "estrategia"] as const).map((id) => ({
    id,
    label: BASE_LABELS[id],
    definition: BASE_DEFINITIONS[id],
    examples: [],
    color: BASE_COLORS[id],
    origin: "base",
    active: true,
  }));
}

/** Devuelve la definición semilla original de un código base (para restaurar). */
export function baseDefinition(id: string): string | undefined {
  return BASE_DEFINITIONS[id];
}

/** Cuenta cuántos códigos base están activos. */
export function activeBaseCount(codebook: Code[]): number {
  return codebook.filter((c) => c.origin === "base" && c.active).length;
}

/** Cuenta cuántos códigos custom hay. */
export function customCount(codebook: Code[]): number {
  return codebook.filter((c) => c.origin === "custom").length;
}

/**
 * Indica si se puede desactivar un código dado el estado actual.
 * Regla: siempre debe quedar al menos un código base activo (máx 2 de 3
 * desactivados). Solo aplica a códigos base activos.
 */
export function canDeactivate(codebook: Code[], code: Code): boolean {
  if (code.origin !== "base" || !code.active) return true;
  return activeBaseCount(codebook) > 1;
}

/** Indica si se puede añadir un código custom más (respeta el máximo). */
export function canAddCustom(codebook: Code[]): boolean {
  return customCount(codebook) < MAX_CUSTOM_CODES;
}

/** Autoasigna un color de la paleta evitando colisiones con los ya usados. */
export function pickColor(codebook: Code[]): string {
  const used = new Set(codebook.map((c) => c.color));
  return CUSTOM_PALETTE.find((c) => !used.has(c)) ?? CUSTOM_PALETTE[0];
}

/** Resultado de validar un formulario de código. */
export interface CodeValidation {
  ok: boolean;
  error?: string;
}

/**
 * Valida los datos de un código custom antes de guardarlo.
 * @param label etiqueta propuesta
 * @param definition definición propuesta
 * @param codebook codebook actual
 * @param editingId id del código que se edita (para permitir su propio nombre)
 */
export function validateCode(
  label: string,
  definition: string,
  codebook: Code[],
  editingId?: string
): CodeValidation {
  const name = label.trim();
  if (!name) return { ok: false, error: "El nombre es obligatorio." };

  // Nombre único sin distinguir mayúsculas/minúsculas.
  const clash = codebook.some(
    (c) => c.id !== editingId && c.label.trim().toLowerCase() === name.toLowerCase()
  );
  if (clash) return { ok: false, error: "Ya existe un código con ese nombre." };

  // Un código custom requiere definición.
  if (!definition.trim())
    return { ok: false, error: "La definición es obligatoria para códigos custom." };

  return { ok: true };
}
