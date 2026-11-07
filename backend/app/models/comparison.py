"""Modelos de salida de la comparación humano vs LLM (Fase II)."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class CodeMetric(BaseModel):
    """Métricas léxicas de un código (humano como referencia)."""

    code: str
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    kappa: Optional[float] = Field(None, description="Cohen's kappa (binario) del código")


class OverallMetrics(BaseModel):
    """Métricas globales (micro) de la comparación."""

    precision: float
    recall: float
    f1: float
    kappa: Optional[float] = None


class UnitDiff(BaseModel):
    """Diff por oración: qué códigos puso cada lado y el estado de acuerdo."""

    start: int
    end: int
    text: str
    human: List[str] = Field(default_factory=list, description="Códigos humanos")
    llm: List[str] = Field(default_factory=list, description="Códigos del LLM")
    status: str = Field(
        ..., description="agree | only_human | only_llm | partial | none"
    )


class FragmentSim(BaseModel):
    """Un fragmento (de un lado) con su máxima similitud semántica al otro lado."""

    code: str
    quote: str
    start: int
    end: int
    max_similarity: float = Field(..., description="Máx. coseno con el otro lado")
    justification: str = ""  # lado LLM
    comment: str = ""        # lado humano
    best_match_quote: str = Field("", description="Cita más parecida del otro lado")
    best_match_code: str = Field("", description="Código de la cita más parecida")


class DocumentComparison(BaseModel):
    """Resultado de comparar un documento."""

    name: str
    full_text: str
    units: List[UnitDiff] = Field(default_factory=list)
    per_code: List[CodeMetric] = Field(default_factory=list)
    overall: OverallMetrics
    llm_fragments: List[FragmentSim] = Field(
        default_factory=list, description="Fragmentos del LLM con su similitud al humano"
    )
    human_fragments: List[FragmentSim] = Field(
        default_factory=list, description="Fragmentos humanos con su similitud al LLM"
    )


class HumanSummary(BaseModel):
    """Resumen de la codificación humana: cuántas citas hay por código."""

    by_code: dict = Field(
        default_factory=dict, description="Conteo de citas por código (normalizado)"
    )
    total: int = Field(0, description="Total de citas (código no vacío)")
    documents: List[str] = Field(
        default_factory=list, description="Documentos presentes en el archivo"
    )


class ComparisonResult(BaseModel):
    """Resultado completo de la comparación."""

    documents: List[DocumentComparison] = Field(default_factory=list)
    embedding_model: str = ""
    default_threshold: float = 0.7
    unmapped: List[str] = Field(
        default_factory=list, description="Citas humanas que no se encontraron en el texto"
    )
