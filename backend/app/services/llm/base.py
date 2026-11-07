"""Interfaz común de proveedores de LLM y utilidades compartidas.

Define la abstracción :class:`LLMProvider` para que el LLM local (Ollama) sea
intercambiable por uno desplegado en la nube sin tocar el pipeline. El formato
del prompt y el parseo de la respuesta son agnósticos al proveedor, así que
viven aquí y se reutilizan en todas las implementaciones.
"""
from __future__ import annotations

import abc
import json
from dataclasses import dataclass
from typing import List

from app.models.code import Code, ExampleKind
from app.services.segmentation import Unit


@dataclass
class RawCoding:
    """Una codificación cruda tal como la devuelve el LLM (antes de validar).

    ``unit_start``/``unit_end`` son IDs de unidad (un rango consecutivo; para una
    sola oración ambos coinciden). El pipeline valida IDs y códigos después.
    """

    unit_start: int
    unit_end: int
    code: str
    justification: str


class LLMError(RuntimeError):
    """Error al comunicarse con el LLM o al interpretar su salida."""


class LLMProvider(abc.ABC):
    """Contrato que debe cumplir cualquier proveedor de LLM.

    El pipeline depende solo de esta interfaz; las implementaciones concretas
    (Ollama, nube, ...) se seleccionan en :mod:`app.services.llm.factory`.
    """

    @abc.abstractmethod
    def code_units(self, units: List[Unit], codebook: List[Code]) -> List[RawCoding]:
        """Codifica una ventana de unidades y devuelve codificaciones crudas.

        Args:
            units: unidades-oración de la ventana (con IDs globales del documento).
            codebook: códigos activos con definiciones y ejemplos.

        Returns:
            Lista de :class:`RawCoding` sin validar todavía.

        Raises:
            LLMError: si no se obtiene una respuesta utilizable.
        """
        raise NotImplementedError


# --------------------------------------------------------------------------
# Utilidades compartidas: construcción del prompt y parseo de la respuesta.
# Son independientes del proveedor concreto.
# --------------------------------------------------------------------------


def _format_codebook(codebook: List[Code]) -> str:
    """Formatea el codebook para el prompt: etiqueta, definición y ejemplos.

    Solo incluye códigos activos y separa ejemplos positivos de negativos.
    """
    lines: List[str] = []
    for code in codebook:
        if not code.active:
            continue
        lines.append(f'### Código: "{code.label}"')
        if code.definition.strip():
            lines.append(f"Definición: {code.definition.strip()}")
        positives = [e.text for e in code.examples if e.kind == ExampleKind.positive]
        negatives = [e.text for e in code.examples if e.kind == ExampleKind.negative]
        if positives:
            lines.append("Ejemplos que SÍ son este código: " + "; ".join(positives))
        if negatives:
            lines.append("Ejemplos que NO son este código: " + "; ".join(negatives))
        lines.append("")
    return "\n".join(lines).strip()


def _format_units(units: List[Unit]) -> str:
    """Formatea las unidades numeradas como ``[U<id>] texto`` para el prompt."""
    return "\n".join(f"[U{u.id}] {u.text}" for u in units)


def build_prompt(units: List[Unit], codebook: List[Code]) -> str:
    """Construye el prompt de codificación para una ventana de unidades.

    Args:
        units: unidades-oración de la ventana (IDs globales del documento).
        codebook: códigos activos con sus definiciones y ejemplos.

    Returns:
        El texto del prompt que se enviará al LLM.
    """
    labels = ", ".join(f'"{c.label}"' for c in codebook if c.active)
    codebook_block = _format_codebook(codebook)
    units_block = _format_units(units)
    # Rango de IDs válidos de ESTA ventana (evita que el modelo referencie IDs
    # inexistentes). Las unidades de una ventana son contiguas.
    min_id = units[0].id
    max_id = units[-1].id
    return f"""Eres un asistente experto en análisis cualitativo de entrevistas en español
sobre sistemas alimentarios. Tu tarea es codificar el texto: identificar los
fragmentos que corresponden a alguno de los códigos definidos.

CÓDIGOS DISPONIBLES (usa EXCLUSIVAMENTE estas etiquetas: {labels}):

{codebook_block}

TEXTO A CODIFICAR (cada oración está numerada con un ID [U<n>]):

{units_block}

INSTRUCCIONES:
- Devuelve únicamente los fragmentos que correspondan CLARAMENTE a algún código;
  si dudas, no lo incluyas (mejor precisión que exhaustividad).
- IDs de unidad VÁLIDOS: de U{min_id} a U{max_id}. NO uses ningún ID fuera de ese
  rango ni inventes números.
- Elige el tramo MÍNIMO que se entienda POR SÍ SOLO: la cita, leída sin más
  contexto, debe dejar claro el SUJETO y el MOTIVO por el que aplica el código.
  Si la oración clave es muy breve o depende de la anterior (p. ej. "Eso fue
  clave.", "Por eso lo hicimos."), INCLUYE la(s) oración(es) contiguas necesarias
  para que se entienda. Prefiere una cita autocontenida antes que una demasiado
  corta; aun así, no incluyas oraciones que no aporten al código.
- Un fragmento es una sola oración (unit_start == unit_end) o —cuando haga falta
  para que se entienda— un rango consecutivo (unit_start < unit_end).
- NO devuelvas rangos que se solapen o se aniden para el MISMO código; usa un solo
  fragmento por idea.
- Un mismo tramo SÍ puede recibir códigos DISTINTOS: en ese caso emite una entrada
  por cada código.
- JUSTIFICACIÓN (1 a 2 frases) con un tono NATURAL y VARIADO que sustente la
  decisión. Debe quedar claro por qué el fragmento encaja en el código, conectando
  el criterio relevante de su definición (parafraseado, con tus palabras, NO
  copiado) con la evidencia concreta del texto. Varía la redacción entre
  fragmentos: NO empieces todas igual (evita muletillas como "Según la
  definición…") ni uses fórmulas vacías ("es una barrera", "corresponde al
  código"). Escribe en tercera persona.
  Ejemplos del estilo (variado; adáptalo al código y al texto):
  · "Las trabas burocráticas retrasaron los permisos, obstaculizando la puesta en
     marcha: un factor que impide operar con normalidad."
  · "Crear alianzas con la comunidad es una acción deliberada de la propia
     iniciativa para sortear el problema, propia de una estrategia."
  · "Aprovechar la bodega municipal que ya existía facilitó la operación sin
     esfuerzo adicional, funcionando como soporte del contexto."

EJEMPLO de formato de salida (no del contenido):
{{"fragments": [{{"unit_start": {min_id}, "unit_end": {min_id}, "code": {labels.split(", ")[0]}, "justification": "<explica con tus palabras por qué aplica, citando la evidencia del texto>"}}]}}

Responde SOLO con un objeto JSON con la forma:
{{"fragments": [{{"unit_start": <int>, "unit_end": <int>, "code": "<etiqueta>", "justification": "<texto>"}}]}}
Si no hay fragmentos, responde {{"fragments": []}}.
"""


def build_output_schema(codebook: List[Code]) -> dict:
    """Construye el JSON Schema que restringe la salida del LLM.

    ``code`` se declara como un enum con las etiquetas activas, de modo que el
    modelo no pueda inventar códigos, y los IDs se fuerzan a enteros. Los
    proveedores que soporten salida estructurada (p. ej. Ollama) pueden pasar
    este esquema para garantizar la forma de la respuesta.

    Args:
        codebook: códigos activos.

    Returns:
        Un dict con el JSON Schema del objeto de respuesta.
    """
    labels = [c.label for c in codebook if c.active]
    return {
        "type": "object",
        "properties": {
            "fragments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "unit_start": {"type": "integer"},
                        "unit_end": {"type": "integer"},
                        "code": {"type": "string", "enum": labels},
                        "justification": {"type": "string"},
                    },
                    "required": ["unit_start", "unit_end", "code", "justification"],
                },
            }
        },
        "required": ["fragments"],
    }


def parse_response(content: str) -> List[RawCoding]:
    """Interpreta la respuesta JSON del LLM en una lista de :class:`RawCoding`.

    Es tolerante: si el modelo envuelve el JSON en texto, extrae el objeto
    ``{...}`` más externo. Ignora entradas malformadas y normaliza rangos.

    Raises:
        LLMError: si no logra encontrar/parsear un objeto JSON.
    """
    text = content.strip()
    first, last = text.find("{"), text.rfind("}")
    if first == -1 or last == -1 or last <= first:
        raise LLMError("La respuesta del LLM no contiene JSON")
    try:
        data = json.loads(text[first : last + 1])
    except json.JSONDecodeError as exc:
        raise LLMError(f"JSON inválido del LLM: {exc}") from exc

    fragments = data.get("fragments", [])
    if not isinstance(fragments, list):
        raise LLMError("El campo 'fragments' no es una lista")

    result: List[RawCoding] = []
    for item in fragments:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item["unit_start"])
            end = int(item.get("unit_end", start))  # una sola unidad si falta
            code = str(item["code"]).strip()
            just = str(item.get("justification", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue  # entrada malformada: se ignora
        if not code:
            continue
        if end < start:  # normaliza rangos invertidos
            start, end = end, start
        result.append(RawCoding(unit_start=start, unit_end=end, code=code, justification=just))
    return result
