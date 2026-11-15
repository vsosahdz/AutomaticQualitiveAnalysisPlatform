"""Rutas de comparación de codificaciones.

- ``POST /compare``: humano vs LLM (Fase II). Recibe la codificación del LLM (JSON)
  y la humana (CSV/XLSX) por multipart, y devuelve métricas léxicas y similitudes.
- ``POST /compare/ab``: dos codificaciones cualesquiera (CSV/XLSX o JSON de la
  herramienta) con métricas simétricas.
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from pydantic import ValidationError as PydanticValidationError

from collections import Counter

from app.models.comparison import ComparisonResult, HumanSummary, PairComparisonResult
from app.models.report import ReportRequest
from app.models.results import Document
from app.services import coding_sources, comparison, docx_report
from app.services.embeddings import EmbeddingError
from app.services.human_import import parse_human_file

DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

router = APIRouter(tags=["comparison"])


@router.post(
    "/compare",
    response_model=ComparisonResult,
    summary="Comparar codificación humana vs LLM",
    description=(
        "Recibe la codificación del LLM (campo `llm`: JSON con una lista de "
        "documentos {name, full_text, fragments}) y la codificación humana "
        "(archivo CSV/XLSX con columnas document, quotation, codes, comment). "
        "Devuelve métricas léxicas (P/R/F1, Cohen's kappa), similitudes semánticas "
        "y las citas no mapeadas."
    ),
    responses={
        200: {"description": "Resultado de la comparación"},
        422: {"description": "Entrada inválida"},
        502: {"description": "El servicio de embeddings no respondió"},
    },
)
async def compare(
    llm: str = Form(..., description="JSON con la lista de documentos del LLM"),
    human_file: UploadFile = File(..., description="Codificación humana (CSV o XLSX)"),
) -> ComparisonResult:
    """Ejecuta la comparación humano vs LLM."""
    # 1) Parsear la codificación del LLM.
    try:
        raw = json.loads(llm)
        llm_docs: List[Document] = [Document(**d) for d in raw]
    except (json.JSONDecodeError, TypeError, PydanticValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Codificación del LLM inválida: {exc}",
        )
    if not llm_docs:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Se requiere al menos un documento del LLM",
        )

    # 2) Parsear la codificación humana.
    content = await human_file.read()
    try:
        human_entries = parse_human_file(human_file.filename or "", content)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    if not human_entries:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La codificación humana no tiene entradas válidas (revisa las columnas)",
        )

    # 3) Comparar (embeddings locales).
    try:
        return comparison.compare(llm_docs, human_entries)
    except EmbeddingError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


@router.post(
    "/compare/ab",
    response_model=PairComparisonResult,
    summary="Comparar dos codificaciones cualesquiera (A vs B)",
    description=(
        "Cada lado (`a_files`, `b_files`) es un archivo CSV/XLSX de codificación "
        "humana (columnas document, quotation, codes, comment) o uno o varios JSON "
        "exportados por la herramienta (incluidos los editados por personas; se "
        "ignoran los fragmentos eliminados). Si ningún lado trae el texto completo "
        "de un documento, se toma de `transcripts` (TXT). Devuelve métricas "
        "simétricas (Cohen's kappa, acuerdo observado y acuerdo específico "
        "positivo), el diff por oración y las similitudes semánticas."
    ),
    responses={
        200: {"description": "Resultado de la comparación A vs B"},
        422: {"description": "Entrada inválida o sin documentos comparables"},
        502: {"description": "El servicio de embeddings no respondió"},
    },
)
async def compare_ab(
    a_files: List[UploadFile] = File(..., description="Codificación A (CSV/XLSX o JSON)"),
    b_files: List[UploadFile] = File(..., description="Codificación B (CSV/XLSX o JSON)"),
    transcripts: Optional[List[UploadFile]] = File(
        None, description="Transcripciones TXT (si ningún lado trae el texto)"
    ),
    a_label: str = Form("A", description="Nombre del lado A"),
    b_label: str = Form("B", description="Nombre del lado B"),
) -> PairComparisonResult:
    """Ejecuta la comparación A vs B."""

    async def read_all(files: Optional[List[UploadFile]]):
        return [(f.filename or "", await f.read()) for f in files or []]

    try:
        side_a = coding_sources.load_side(await read_all(a_files))
        side_b = coding_sources.load_side(await read_all(b_files))
        texts = coding_sources.load_transcripts(await read_all(transcripts))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    documents, missing, notes = coding_sources.assemble(side_a, side_b, texts)
    if not documents:
        detail = "No hay documentos con texto disponible para comparar"
        if missing:
            detail += f" (carga la transcripción TXT de: {', '.join(missing)})"
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)

    a_name = a_label.strip() or "A"
    b_name = b_label.strip() or "B"
    try:
        return comparison.compare_ab(documents, a_name, b_name, missing, notes)
    except EmbeddingError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


@router.post(
    "/human/summary",
    response_model=HumanSummary,
    summary="Resumen de la codificación humana",
    description=(
        "Recibe el archivo humano (CSV/XLSX) y devuelve cuántas citas hay por "
        "código (aplicando la normalización de códigos), para cuantificar la "
        "codificación humana antes de compararla con la del LLM."
    ),
    responses={
        200: {"description": "Conteo por código"},
        422: {"description": "Archivo inválido o sin entradas"},
    },
)
async def human_summary(
    human_file: UploadFile = File(..., description="Codificación humana (CSV o XLSX)"),
) -> HumanSummary:
    """Cuantifica las citas humanas por código."""
    content = await human_file.read()
    try:
        entries = parse_human_file(human_file.filename or "", content)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    by_code = Counter(e.code for e in entries)
    documents = sorted({e.document for e in entries if e.document})
    return HumanSummary(by_code=dict(by_code), total=len(entries), documents=documents)


@router.post(
    "/report/docx",
    summary="Reporte DOCX de hallazgos solo-IA",
    description=(
        "Genera un documento Word con, por cada documento, la explicación en "
        "lenguaje natural del reporte léxico y la lista de hallazgos solo-IA "
        "(con similitud y relevancia marcada)."
    ),
    responses={
        200: {"description": "Documento .docx", "content": {DOCX_MEDIA: {}}},
        422: {"description": "Entrada inválida"},
    },
)
def report_docx(request: ReportRequest) -> Response:
    """Devuelve el reporte de hallazgos solo-IA como archivo DOCX."""
    docx_bytes = docx_report.build_docx(request)
    return Response(
        content=docx_bytes,
        media_type=DOCX_MEDIA,
        headers={"Content-Disposition": 'attachment; filename="hallazgos_IA_AQA.docx"'},
    )
