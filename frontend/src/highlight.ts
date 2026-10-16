// Utilidad para convertir una lista de fragmentos con offsets (que pueden
// solaparse) en una secuencia lineal de segmentos sin solapes, cada uno con la
// lista de códigos que lo cubren. Esto permite pintar el texto de una pasada y
// distinguir visualmente los tramos multicódigo.
import type { CodedDocument, Fragment } from "./types";

/** Un segmento contiguo del texto con los códigos y fragmentos que lo cubren. */
export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Códigos que cubren este segmento (vacío = texto sin codificar). */
  codes: string[];
  /** Fragmentos que cubren este segmento (para mostrar sus justificaciones). */
  fragments: Fragment[];
}

/**
 * Descompone el texto en segmentos sin solape usando las fronteras de todos los
 * fragmentos. Cada segmento sabe qué códigos lo cubren (0, 1 o varios).
 *
 * @param doc documento codificado (texto completo + fragmentos)
 * @returns lista ordenada de segmentos que cubren todo el texto
 */
export function buildSegments(doc: CodedDocument): Segment[] {
  const text = doc.full_text;
  const fragments = doc.fragments;

  // Recoge todas las fronteras (inicios y fines) más los extremos del texto.
  const bounds = new Set<number>([0, text.length]);
  for (const f of fragments) {
    if (f.start >= 0 && f.start <= text.length) bounds.add(f.start);
    if (f.end >= 0 && f.end <= text.length) bounds.add(f.end);
  }
  const points = Array.from(bounds).sort((a, b) => a - b);

  // Para cada tramo [points[i], points[i+1]), calcula qué códigos lo cubren.
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const covering = coveringFragments(fragments, start, end);
    const codes: string[] = [];
    for (const f of covering) if (!codes.includes(f.code)) codes.push(f.code);
    segments.push({
      start,
      end,
      text: text.slice(start, end),
      codes,
      fragments: covering,
    });
  }
  return segments;
}

/** Devuelve los fragmentos que cubren por completo el tramo [start, end). */
function coveringFragments(
  fragments: Fragment[],
  start: number,
  end: number
): Fragment[] {
  return fragments.filter((f) => f.start <= start && f.end >= end);
}
