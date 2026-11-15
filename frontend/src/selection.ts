// Conversión de una selección del navegador a offsets sobre el texto original.
//
// En modo edición el visor pinta cada segmento como un elemento con
// `data-start` (su offset en `full_text`) cuyo único hijo es un nodo de texto
// con el texto original sin transformar. Así, el offset de un punto de la
// selección es `data-start` + el desplazamiento dentro de ese nodo.

/** Elemento de segmento (con `data-start`) que contiene al nodo, dentro de root. */
function segmentOf(node: Node, root: HTMLElement): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const seg = el?.closest<HTMLElement>("[data-start]") ?? null;
  return seg && root.contains(seg) ? seg : null;
}

/** Offset inicial y longitud de un elemento de segmento. */
function segBounds(seg: HTMLElement): { start: number; length: number } {
  return { start: Number(seg.dataset.start), length: seg.textContent?.length ?? 0 };
}

/**
 * Convierte un punto (nodo, offset) del DOM en un offset del texto original.
 * @returns el offset, o null si el punto está fuera del visor
 */
export function pointToOffset(node: Node, offset: number, root: HTMLElement): number | null {
  if (!root.contains(node)) return null;

  // Punto dentro de un segmento (su nodo de texto o el propio elemento).
  const seg = segmentOf(node, root);
  if (seg) {
    const { start, length } = segBounds(seg);
    if (node.nodeType === Node.TEXT_NODE) return start + Math.min(offset, length);
    // Punto en el elemento: offset es un índice de hijos (0 = inicio, otro = fin).
    return offset === 0 ? start : start + length;
  }

  // Punto en el contenedor (p. ej. el párrafo): offset es un índice de hijos.
  if (node === root || node.nodeType === Node.ELEMENT_NODE) {
    const children = Array.from(node.childNodes);
    // Primer segmento a partir del índice: el punto está justo antes de él.
    for (let i = offset; i < children.length; i++) {
      const s = segmentOf(children[i], root);
      if (s) return segBounds(s).start;
    }
    // Ningún segmento después: el punto está al final del último.
    for (let i = Math.min(offset, children.length) - 1; i >= 0; i--) {
      const s = segmentOf(children[i], root);
      if (s) {
        const { start, length } = segBounds(s);
        return start + length;
      }
    }
  }
  return null;
}

/**
 * Convierte un rango del DOM en offsets [start, end) del texto original.
 * @returns los offsets, o null si el rango está vacío o sale del visor
 */
export function rangeToOffsets(
  range: Pick<Range, "startContainer" | "startOffset" | "endContainer" | "endOffset" | "collapsed">,
  root: HTMLElement
): { start: number; end: number } | null {
  if (range.collapsed) return null;
  const a = pointToOffset(range.startContainer, range.startOffset, root);
  const b = pointToOffset(range.endContainer, range.endOffset, root);
  if (a === null || b === null || a === b) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
