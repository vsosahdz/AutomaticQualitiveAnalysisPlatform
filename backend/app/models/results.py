"""Modelos de salida: resultado JSON rico, estado del trabajo y descartes.

El resultado JSON es la fuente única de verdad: alimenta el visor del frontend y
de él se deriva el CSV.
"""
from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class Fragment(BaseModel):
    """Un fragmento codificado dentro de un documento.

    Los offsets ``start``/``end`` son posiciones de carácter exactas sobre el
    texto original, de modo que ``quote == full_text[start:end]`` y el visor
    puede resaltar sin ambigüedad. Un fragmento multicódigo se representa como
    varias entradas ``Fragment`` (una por código).
    """

    start: int = Field(..., ge=0, description="Offset de inicio (inclusive)")
    end: int = Field(..., ge=0, description="Offset de fin (exclusivo)")
    code: str = Field(..., description="Etiqueta del código asignado")
    quote: str = Field(..., description="Texto citado (== full_text[start:end])")
    justification: str = Field("", description="Justificación breve del LLM")
    models: List[str] = Field(
        default_factory=list,
        description="Modelos que coincidieron (solo en análisis por consenso)",
    )


class Document(BaseModel):
    """Un documento codificado: su nombre, su texto completo y sus fragmentos."""

    name: str = Field(..., description="Nombre del archivo")
    full_text: str = Field(..., description="Texto completo original")
    fragments: List[Fragment] = Field(
        default_factory=list, description="Fragmentos codificados"
    )
    elapsed_seconds: float = Field(
        0.0, ge=0.0, description="Segundos que tomó codificar este documento"
    )


class Dropped(BaseModel):
    """Registro de una salida del LLM descartada por inválida.

    Sirve para trazabilidad: IDs de unidad fuera de rango o códigos inventados.
    """

    document: str = Field(..., description="Documento donde ocurrió")
    reason: str = Field(..., description="Motivo del descarte")
    raw: str = Field("", description="Fragmento de la salida cruda del LLM")


class Result(BaseModel):
    """Resultado completo de un trabajo de codificación."""

    documents: List[Document] = Field(default_factory=list)
    dropped: List[Dropped] = Field(
        default_factory=list, description="Salidas del LLM descartadas"
    )
    total_seconds: float = Field(
        0.0, ge=0.0, description="Segundos totales del trabajo de codificación"
    )
    analysis_type: str = Field(
        "single", description="Tipo de análisis: 'single' o 'consensus'"
    )
    models: List[str] = Field(
        default_factory=list, description="Modelos usados (ensamble en consenso)"
    )


class JobState(str, Enum):
    """Estados posibles de un trabajo de codificación."""

    pending = "pending"
    running = "running"
    done = "done"
    error = "error"
    cancelled = "cancelled"


class JobStatus(BaseModel):
    """Estado y progreso de un trabajo, devuelto por ``GET /jobs/{id}``."""

    job_id: str = Field(..., description="Identificador del trabajo")
    state: JobState = Field(..., description="Estado actual")
    progress: float = Field(
        0.0, ge=0.0, le=1.0, description="Progreso normalizado 0..1"
    )
    message: str = Field("", description="Mensaje legible del progreso")
    error: Optional[str] = Field(None, description="Detalle del error si state=error")
