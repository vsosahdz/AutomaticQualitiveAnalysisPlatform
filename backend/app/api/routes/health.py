"""Ruta de salud del servicio."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.core import config

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Respuesta de ``GET /health``: estado y proveedor/modelo de LLM en uso."""

    status: str
    llm_provider: str
    model: str


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Estado del servicio",
    description="Verifica que la API está viva e informa el proveedor y modelo de LLM configurados.",
)
def health() -> HealthResponse:
    """Devuelve el estado del servicio y la configuración de LLM vigente."""
    return HealthResponse(
        status="ok",
        llm_provider=config.LLM_PROVIDER,
        model=config.OLLAMA_MODEL if config.LLM_PROVIDER == "ollama" else config.CLOUD_LLM_MODEL,
    )
