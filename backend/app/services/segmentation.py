"""Segmentación de transcripciones en unidades-oración con offsets exactos.

Esta es la base de la "Estrategia C": cada oración recibe un ID y offsets de
carácter exactos sobre el texto original crudo. El LLM luego responde con IDs de
unidad (no con texto), y esos IDs se resuelven a offsets para resaltar sin
ambigüedad. Por eso es crítico que ``text[unit.start:unit.end] == unit.text``.

Se usa un segmentador basado en expresiones regulares (sin dependencias externas
ni descargas de modelos) que:
- corta en signos de fin de oración (. ! ? … y sus variantes) seguidos de espacio,
- respeta marcas de hablante (ENTREVISTADOR: / ENTREVISTADO:) como frontera,
- evita cortar en abreviaturas comunes del español.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

# Abreviaturas frecuentes en español tras las que un punto NO cierra oración.
_ABBREVIATIONS = {
    "sr", "sra", "srta", "dr", "dra", "lic", "ing", "arq", "mtro", "mtra",
    "prof", "profa", "etc", "vs", "ej", "p.ej", "aprox", "no", "núm", "pág",
    "av", "gob", "art", "cap", "fig", "tel",
}

# Marca de hablante al inicio de línea, p. ej. "ENTREVISTADOR:" o "Juan Pérez:".
_SPEAKER_RE = re.compile(r"^[ \t]*([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ .]{0,40}?):", re.MULTILINE)

# Candidato a fin de oración: puntuación terminal + espacio(s) o salto de línea.
_SENT_END_RE = re.compile(r"([.!?…]+)([\)\"'»”]*)(\s+)")


@dataclass
class Unit:
    """Una unidad-oración con su ID y offsets exactos sobre el texto original.

    Invariante: ``original_text[start:end] == text``.
    """

    id: int          # ID global dentro del documento (0, 1, 2, ...)
    start: int       # offset de inicio (inclusive) en el texto original
    end: int         # offset de fin (exclusivo) en el texto original
    text: str        # texto exacto de la unidad


def _looks_like_abbreviation(text: str, dot_index: int) -> bool:
    """Indica si el punto en ``dot_index`` pertenece a una abreviatura conocida.

    Mira la palabra inmediatamente anterior al punto y la compara (en minúsculas,
    sin el punto) contra la lista de abreviaturas.
    """
    # Retrocede hasta el inicio de la palabra que precede al punto.
    j = dot_index
    while j > 0 and (text[j - 1].isalnum() or text[j - 1] in ".·"):
        j -= 1
    word = text[j:dot_index].strip().lower().rstrip(".")
    return word in _ABBREVIATIONS


def _split_offsets(text: str) -> List[tuple[int, int]]:
    """Devuelve los rangos (start, end) de cada oración cruda del texto.

    Los rangos cubren el texto sin solaparse; el espacio en blanco entre oraciones
    se asigna al final de la oración previa para no perder caracteres (los offsets
    siempre refieren al original). Luego se recortan los bordes en :func:`segment`.
    """
    boundaries: List[int] = []  # posiciones donde termina una oración

    # 1) Fronteras por puntuación terminal (evitando abreviaturas).
    for m in _SENT_END_RE.finditer(text):
        dot_pos = m.start(1)
        if _looks_like_abbreviation(text, dot_pos):
            continue
        # La oración termina tras la puntuación y su cierre (comillas/paréntesis),
        # justo antes del espacio en blanco.
        boundaries.append(m.start(3))

    # 2) Fronteras por marca de hablante: una nueva intervención inicia oración.
    for m in _SPEAKER_RE.finditer(text):
        if m.start() > 0:
            boundaries.append(m.start())

    # Ordena y deduplica las fronteras.
    boundaries = sorted(set(b for b in boundaries if 0 < b < len(text)))

    # 3) Construye los rangos entre fronteras consecutivas.
    ranges: List[tuple[int, int]] = []
    prev = 0
    for b in boundaries:
        if b > prev:
            ranges.append((prev, b))
            prev = b
    if prev < len(text):
        ranges.append((prev, len(text)))
    return ranges


def segment(text: str) -> List[Unit]:
    """Segmenta ``text`` en unidades-oración con offsets exactos.

    Recorta los espacios en blanco de los extremos de cada oración ajustando los
    offsets (no el texto), descarta unidades vacías y numera con IDs globales.

    Args:
        text: transcripción cruda.

    Returns:
        Lista de :class:`Unit`, cada una con ``text[start:end] == unit.text``.
    """
    units: List[Unit] = []
    next_id = 0
    for raw_start, raw_end in _split_offsets(text):
        start, end = raw_start, raw_end
        # Recorta espacio a la izquierda ajustando el offset de inicio.
        while start < end and text[start].isspace():
            start += 1
        # Recorta espacio a la derecha ajustando el offset de fin.
        while end > start and text[end - 1].isspace():
            end -= 1
        if start >= end:
            continue  # unidad vacía (solo espacios): se omite
        units.append(Unit(id=next_id, start=start, end=end, text=text[start:end]))
        next_id += 1
    return units
