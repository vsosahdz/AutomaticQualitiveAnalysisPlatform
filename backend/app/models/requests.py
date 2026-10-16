"""Modelos de entrada (contrato de la petición de procesamiento)."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field

from app.models.code import Code


class DocumentInput(BaseModel):
    """Un documento de entrada: nombre de archivo + texto de la transcripción."""

    name: str = Field(..., min_length=1, description="Nombre del archivo TXT")
    content: str = Field(..., description="Contenido crudo de la transcripción")


class ProcessRequest(BaseModel):
    """Cuerpo de ``POST /process``.

    Transporta los documentos a codificar y el codebook activo. El backend usa
    este payload sin leer ningún estado previo (codebook sin persistencia).
    """

    documents: List[DocumentInput] = Field(
        ..., min_length=1, description="Uno o varios documentos TXT"
    )
    codebook: List[Code] = Field(
        ..., min_length=1, description="Códigos con los que codificar"
    )
    model: Optional[str] = Field(
        None,
        description="Modelo de LLM a usar (análisis de un solo modelo); si se omite, el default",
    )
    models: Optional[List[str]] = Field(
        None,
        description="Lista de 2–3 modelos para análisis por consenso (ensamble)",
    )

    # Ejemplo de payload que Swagger mostrará y que puede importarse a Postman.
    model_config = {
        "json_schema_extra": {
            "example": {
                "documents": [
                    {
                        "name": "entrevista_01.txt",
                        "content": "ENTREVISTADO: Las trabas burocráticas nos frenaron mucho. Creamos alianzas con otros actores para avanzar.",
                    }
                ],
                "codebook": [
                    {
                        "id": "barrera",
                        "label": "Barrera",
                        "definition": "Una barrera es cualquier condición que dificulta o impide que una iniciativa funcione adecuadamente...",
                        "color": "#E4572E",
                        "origin": "base",
                        "active": True,
                    },
                    {
                        "id": "estrategia",
                        "label": "Estrategia",
                        "definition": "Es una acción que una iniciativa realiza de manera activa y deliberada para superar obstáculos...",
                        "color": "#3A6EA5",
                        "origin": "base",
                        "active": True,
                    },
                ],
            }
        }
    }
