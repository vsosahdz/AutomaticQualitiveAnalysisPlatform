// Renderizado de Markdown para el visor.
//
// El resaltado del visor depende de offsets de caracteres exactos sobre el texto
// original, y los segmentos son porciones arbitrarias de ese texto. Por eso se
// renderiza Markdown EN LÍNEA por segmento (negritas, cursivas, `código`,
// enlaces, etc.), no a nivel de bloque: así se conserva el resaltado por
// fragmento sin desalinear posiciones. El HTML resultante se sanea con DOMPurify
// porque proviene del contenido subido por la persona usuaria.
import { marked } from "marked";
import DOMPurify from "dompurify";

// Sin saltos automáticos: el contenedor del visor ya preserva los saltos de
// línea con `white-space: pre-wrap`.
marked.setOptions({ breaks: false, gfm: true });

/**
 * Convierte un fragmento de texto en HTML de Markdown en línea, ya saneado.
 * @param text porción de texto (segmento) a renderizar
 * @returns HTML seguro listo para inyectar
 */
export function renderInlineMarkdown(text: string): string {
  const html = marked.parseInline(text) as string;
  return DOMPurify.sanitize(html);
}
