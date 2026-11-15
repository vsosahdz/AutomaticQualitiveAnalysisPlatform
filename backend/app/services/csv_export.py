"""Derivación del CSV a partir del resultado JSON rico.

El CSV es una vista del resultado (fuente única de verdad), con exactamente
cuatro columnas: ``archivo, cita, codigo, justificacion``. Los fragmentos
multicódigo ya vienen como entradas separadas en el resultado, así que cada
fragmento produce una fila; los tramos sin código no existen como fragmentos y
por tanto no aparecen.
"""
from __future__ import annotations

import csv
import io
import zipfile
from typing import List

from app.models.results import Document, FragmentOrigin, Result

# Encabezados base del CSV, en el orden acordado.
CSV_HEADERS = ["archivo", "cita", "codigo", "justificacion"]
# Columna adicional presente solo en análisis por consenso.
AGREEMENT_HEADER = "acuerdo"
# Columna adicional presente solo si una persona editó el resultado.
ORIGIN_HEADER = "origen"

# BOM UTF-8 para que Excel abra los CSV con acentos y ñ correctamente.
UTF8_BOM = "﻿"


def has_edits(documents: List[Document]) -> bool:
    """Indica si una persona editó algún documento (origen distinto de llm o eliminados)."""
    return any(
        d.removed_fragments or any(f.origin != FragmentOrigin.llm for f in d.fragments)
        for d in documents
    )


def _write_document_rows(
    writer: "csv._writer", document: Document, total_models: int, with_origin: bool
) -> None:
    """Escribe una fila por fragmento; añade las columnas de acuerdo y origen si aplican."""
    for fragment in document.fragments:
        row = [document.name, fragment.quote, fragment.code, fragment.justification]
        if total_models:  # modo consenso → columna 'acuerdo'
            # Se usa "k de n" (no "k/n") para que Excel/LibreOffice no lo
            # interpreten como una fecha (p. ej. 2/3 → 2 de marzo).
            # Un hallazgo manual no pasó por los modelos: acuerdo vacío.
            manual = fragment.origin == FragmentOrigin.manual
            row.append("" if manual else f"{len(fragment.models)} de {total_models}")
        if with_origin:  # resultado editado → columna 'origen'
            row.append(fragment.origin.value)
        writer.writerow(row)


def _headers(is_consensus: bool, with_origin: bool = False) -> list:
    """Encabezados del CSV según el tipo de análisis y si hubo ediciones."""
    return (
        CSV_HEADERS
        + ([AGREEMENT_HEADER] if is_consensus else [])
        + ([ORIGIN_HEADER] if with_origin else [])
    )


def result_to_csv(result: Result) -> str:
    """Convierte un :class:`Result` en el texto de un CSV.

    Cuatro columnas en modo de un solo modelo; en consenso añade `acuerdo`.
    Incluye todos los documentos (combinado), una fila por fragmento.
    """
    is_consensus = result.analysis_type == "consensus"
    total_models = len(result.models) if is_consensus else 0
    with_origin = has_edits(result.documents)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_headers(is_consensus, with_origin))
    for document in result.documents:
        _write_document_rows(writer, document, total_models, with_origin)
    return buffer.getvalue()


def document_to_csv(
    document: Document, total_models: int = 0, with_origin: bool = False
) -> str:
    """Convierte un solo documento en el texto de un CSV.

    Si ``total_models`` > 0 (consenso), incluye la columna `acuerdo`; si
    ``with_origin``, incluye la columna `origen`.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_headers(total_models > 0, with_origin))
    _write_document_rows(writer, document, total_models, with_origin)
    return buffer.getvalue()


def _safe_csv_name(document_name: str) -> str:
    """Deriva un nombre de archivo CSV a partir del nombre del documento."""
    base = document_name.rsplit(".", 1)[0] if "." in document_name else document_name
    return f"{base}.csv"


def result_to_zip(result: Result) -> bytes:
    """Empaqueta un CSV por documento (con BOM) en un archivo ZIP.

    Args:
        result: resultado JSON rico del trabajo.

    Returns:
        Los bytes del ZIP; cada entrada es ``<documento>.csv`` en UTF-8 con BOM.
    """
    total_models = len(result.models) if result.analysis_type == "consensus" else 0
    with_origin = has_edits(result.documents)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for document in result.documents:
            csv_text = UTF8_BOM + document_to_csv(document, total_models, with_origin)
            zf.writestr(_safe_csv_name(document.name), csv_text.encode("utf-8"))
    return buffer.getvalue()
