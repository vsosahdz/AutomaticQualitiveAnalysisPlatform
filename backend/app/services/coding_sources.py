"""Fuentes de una comparación A vs B: archivos de cada lado y transcripciones.

Cada lado es una codificación humana (CSV/XLSX) o uno o varios JSON exportados
por la herramienta (``aqa-analysis-export``, incluidos los editados por personas).
Este módulo los convierte en elementos por documento y reúne el texto completo de
cada documento desde los JSON o, si ningún lado lo trae, desde las transcripciones
TXT. Los documentos se asocian por nombre sin distinguir mayúsculas ni extensión.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from pydantic import ValidationError

from app.models.results import Document
from app.services.comparison import PairDocument, SideItem
from app.services.human_import import parse_human_file

# Marca de los JSON de análisis exportados por la herramienta (frontend/src/aqaFile.ts).
AQA_ANALYSIS_KIND = "aqa-analysis-export"

_EXT_RE = re.compile(r"\.[A-Za-z0-9]{1,5}$")


def doc_key(name: str) -> str:
    """Clave de asociación de un documento: minúsculas, sin espacios ni extensión."""
    return _EXT_RE.sub("", (name or "").strip()).lower()


@dataclass
class Side:
    """Una codificación (lado A o B) ya interpretada."""

    kind: str  # "csv" (humano) o "json" (herramienta)
    # Elementos por clave de documento.
    items: Dict[str, List[SideItem]] = field(default_factory=dict)
    # Texto completo y nombre visible por clave (solo los JSON los traen).
    texts: Dict[str, str] = field(default_factory=dict)
    names: Dict[str, str] = field(default_factory=dict)


def _decode(content: bytes) -> str:
    return content.decode("utf-8-sig")


def _parse_aqa_json(filename: str, content: bytes) -> Document:
    """Interpreta un JSON exportado por la herramienta y devuelve su documento."""
    try:
        data = json.loads(_decode(content))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{filename}: no es un JSON válido ({exc})") from exc
    if not isinstance(data, dict) or (data.get("aqa") or {}).get("kind") != AQA_ANALYSIS_KIND:
        raise ValueError(f"{filename}: no es un análisis exportado por la herramienta")
    try:
        return Document(**data["document"])
    except (KeyError, TypeError, ValidationError) as exc:
        raise ValueError(f"{filename}: el documento del JSON no es válido ({exc})") from exc


def load_side(files: List[Tuple[str, bytes]]) -> Side:
    """Interpreta los archivos de un lado.

    Args:
        files: pares (nombre de archivo, contenido).

    Returns:
        El :class:`Side` con los elementos por documento.

    Raises:
        ValueError: si no hay archivos, si se mezclan CSV/XLSX con JSON, si hay
            más de un CSV/XLSX o si algún archivo no es válido.
    """
    if not files:
        raise ValueError("Cada lado necesita al menos un archivo")
    kinds = {"json" if n.lower().endswith(".json") else "csv" for n, _ in files}
    if len(kinds) > 1:
        raise ValueError("Un lado no puede mezclar CSV/XLSX con JSON")
    kind = kinds.pop()
    side = Side(kind=kind)

    if kind == "csv":
        if len(files) > 1:
            raise ValueError("Cada lado admite un solo archivo CSV/XLSX")
        filename, content = files[0]
        for e in parse_human_file(filename, content):
            key = doc_key(e.document)
            side.items.setdefault(key, []).append(
                SideItem(code=e.code, quote=e.quotation, note=e.comment, note_field="comment")
            )
            side.names.setdefault(key, e.document)
        return side

    for filename, content in files:
        doc = _parse_aqa_json(filename, content)
        key = doc_key(doc.name)
        side.texts[key] = doc.full_text
        side.names[key] = doc.name
        # Solo los fragmentos vigentes: los eliminados por una persona no cuentan.
        side.items[key] = [
            SideItem(code=f.code, quote=f.quote, note=f.justification,
                     note_field="justification", start=f.start, end=f.end)
            for f in doc.fragments
        ]
    return side


def load_transcripts(files: List[Tuple[str, bytes]]) -> Dict[str, Tuple[str, str]]:
    """Lee las transcripciones TXT: clave de documento → (nombre, texto)."""
    out: Dict[str, Tuple[str, str]] = {}
    for filename, content in files:
        if not filename.lower().endswith(".txt"):
            raise ValueError(f"{filename}: las transcripciones deben ser TXT")
        try:
            out[doc_key(filename)] = (filename, _decode(content))
        except UnicodeDecodeError as exc:
            raise ValueError(f"{filename}: no está en UTF-8 ({exc})") from exc
    return out


def _single_document_keys(
    side_a: Side, side_b: Side, transcripts: Dict[str, Tuple[str, str]]
) -> Optional[str]:
    """Si cada fuente tiene un único documento, devuelve la clave común a usar.

    Así se asocian aunque los nombres difieran (p. ej. un CSV sin columna
    ``document`` y un JSON ``entrevista_01.txt``).
    """
    sources = [set(side_a.items), set(side_b.items)]
    if transcripts:
        sources.append(set(transcripts))
    if not all(len(s) == 1 for s in sources):
        return None
    keys = [next(iter(s)) for s in sources]
    if len(set(keys)) == 1:
        return None  # ya coinciden; no hace falta unificar
    # Preferencia del nombre: JSON de A, JSON de B, transcripción, CSV de A.
    for side in (side_a, side_b):
        if side.texts:
            return next(iter(side.texts))
    if transcripts:
        return next(iter(transcripts))
    return keys[0]


def _rekey(side: Side, key: str) -> None:
    """Mueve el único documento de un lado a la clave indicada."""
    (old,) = tuple(side.items)
    if old == key:
        return
    side.items[key] = side.items.pop(old)
    if old in side.texts:
        side.texts[key] = side.texts.pop(old)
    if old in side.names:
        side.names[key] = side.names.pop(old)


def assemble(
    side_a: Side,
    side_b: Side,
    transcripts: Dict[str, Tuple[str, str]],
) -> Tuple[List[PairDocument], List[str], List[str]]:
    """Reúne los documentos a comparar con su texto y los elementos de cada lado.

    Returns:
        ``(documentos, sin_texto, avisos)``: los documentos con texto disponible,
        los nombres de los que se omitieron por no tenerlo y avisos de conflicto.
    """
    notes: List[str] = []
    common = _single_document_keys(side_a, side_b, transcripts)
    if common is not None:
        _rekey(side_a, common)
        _rekey(side_b, common)
        if transcripts:
            ((_, value),) = transcripts.items()
            transcripts = {common: value}

    keys = list(dict.fromkeys([*side_a.items, *side_b.items]))
    documents: List[PairDocument] = []
    missing: List[str] = []
    for key in keys:
        # Nombre visible: JSON (A, B), transcripción, CSV (A, B).
        name = (
            (side_a.names.get(key) if side_a.texts.get(key) is not None else None)
            or (side_b.names.get(key) if side_b.texts.get(key) is not None else None)
            or (transcripts[key][0] if key in transcripts else None)
            or side_a.names.get(key)
            or side_b.names.get(key)
            or key
        )
        text_a = side_a.texts.get(key)
        text_b = side_b.texts.get(key)
        if text_a is not None and text_b is not None and text_a != text_b:
            notes.append(f"{name}: los JSON de A y B traen textos distintos; se usa el de A")
        text = text_a if text_a is not None else text_b
        if text is None and key in transcripts:
            text = transcripts[key][1]
        if text is None:
            missing.append(name)
            continue
        documents.append(
            PairDocument(
                name=name,
                full_text=text,
                items_a=side_a.items.get(key, []),
                items_b=side_b.items.get(key, []),
            )
        )
    return documents, missing, notes
