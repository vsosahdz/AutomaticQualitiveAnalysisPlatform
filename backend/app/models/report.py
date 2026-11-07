"""Modelos de entrada para generar el reporte DOCX de hallazgos solo-IA.

El frontend arma el payload (ya filtrado por umbral y con la relevancia marcada)
y el backend solo lo renderiza a DOCX, incluyendo la explicación en lenguaje
natural del reporte léxico.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from app.models.comparison import CodeMetric, OverallMetrics


class ReportFinding(BaseModel):
    """Un hallazgo solo-IA para el reporte."""

    code: str
    quote: str
    justification: str = ""
    max_similarity: float = 0.0
    best_match_quote: str = ""
    best_match_code: str = ""
    relevancia: str = Field("", description="'relevant' | 'no' | '' (sin marcar)")
    context: str = Field("", description="Texto que rodea la cita en el documento")
    definition: str = Field("", description="Definición del código aplicada")


class DiffCounts(BaseModel):
    """Conteo de oraciones por estado de acuerdo del diff."""

    agree: int = 0
    only_llm: int = 0
    only_human: int = 0
    partial: int = 0


class ReportDocument(BaseModel):
    """Datos de un documento para el reporte."""

    name: str
    overall: OverallMetrics
    per_code: List[CodeMetric] = Field(default_factory=list)
    diff_counts: Optional[DiffCounts] = None
    only_ai: List[ReportFinding] = Field(default_factory=list)


class ReportRequest(BaseModel):
    """Payload de ``POST /report/docx``."""

    embedding_model: str = ""
    threshold: float = 0.7
    definitions: Dict[str, str] = Field(
        default_factory=dict,
        description="Definiciones de los códigos (etiqueta → definición), una sola vez",
    )
    documents: List[ReportDocument] = Field(default_factory=list)
