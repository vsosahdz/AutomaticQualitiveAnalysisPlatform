"""Punto de entrada de la API (index).

Crea la aplicación FastAPI, configura CORS, monta los routers y define la
metadata de OpenAPI/Swagger para que la documentación autogenerada
(`/docs`, `/redoc`, `/openapi.json`) sea rica y pueda importarse a Postman.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import analysis, comparison, health
from app.core import config

# Descripción de los grupos de endpoints, visible en Swagger UI.
TAGS_METADATA = [
    {"name": "health", "description": "Estado del servicio."},
    {
        "name": "analysis",
        "description": "Codificación de transcripciones y recuperación de resultados.",
    },
    {
        "name": "comparison",
        "description": "Comparación de codificación humana vs LLM (Fase II).",
    },
]


def create_app() -> FastAPI:
    """Crea y configura la instancia de FastAPI.

    Returns:
        La aplicación lista para servir.
    """
    app = FastAPI(
        title="Análisis Cualitativo Automático",
        version="0.1.0",
        description=(
            "API de codificación asistida por LLM para investigación cualitativa "
            "en sistemas alimentarios. Recibe transcripciones TXT y un codebook, y "
            "devuelve fragmentos codificados (Estrategia C: el LLM responde con IDs "
            "de unidad para un resaltado exacto)."
        ),
        openapi_tags=TAGS_METADATA,
    )

    # CORS para permitir que el frontend (Vite) consuma la API en desarrollo.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Montaje de routers (rutas delgadas).
    app.include_router(health.router)
    app.include_router(analysis.router)
    app.include_router(comparison.router)
    return app


# Instancia de la app usada por Uvicorn: `uvicorn app.main:app`.
app = create_app()
