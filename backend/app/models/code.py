"""Modelos de datos de un código del codebook.

Un "código" es una categoría de análisis cualitativo (p. ej. Barrera) con la que
el LLM etiqueta fragmentos del texto. El codebook (conjunto de códigos) viaja
completo en cada petición porque el backend es sin estado.
"""
from __future__ import annotations

from enum import Enum
from typing import List

from pydantic import BaseModel, Field, field_validator, model_validator


class CodeOrigin(str, Enum):
    """Origen de un código.

    - ``base``: uno de los tres códigos fijos (Barrera, Facilitador, Estrategia).
    - ``custom``: código añadido por la persona usuaria desde el frontend.
    """

    base = "base"
    custom = "custom"


class ExampleKind(str, Enum):
    """Tipo de un ejemplo few-shot: ilustra un caso positivo o negativo del código."""

    positive = "positive"
    negative = "negative"


class FewShotExample(BaseModel):
    """Ejemplo few-shot opcional adjunto a un código.

    Se inyecta en el prompt del LLM para mejorar la precisión: los positivos
    muestran qué SÍ es el código y los negativos qué NO es.
    """

    text: str = Field(..., min_length=1, description="Texto del ejemplo")
    kind: ExampleKind = Field(
        ExampleKind.positive,
        description="Si el ejemplo ilustra un caso positivo o negativo del código",
    )


class Code(BaseModel):
    """Un código del codebook enviado por el frontend en cada petición.

    El codebook es sin estado: el backend no lo persiste entre peticiones, solo
    lo usa para construir el prompt y para validar la salida del LLM.
    """

    id: str = Field(..., description="Identificador estable, p. ej. 'facilitador'")
    label: str = Field(..., min_length=1, description="Etiqueta visible; va al CSV")
    definition: str = Field(
        "",
        description="Definición del código. Obligatoria para códigos custom.",
    )
    examples: List[FewShotExample] = Field(
        default_factory=list,
        description="Ejemplos few-shot opcionales (positivos/negativos)",
    )
    color: str = Field("#5C6672", description="Color para el resaltado del visor")
    origin: CodeOrigin = Field(CodeOrigin.custom, description="base | custom")
    active: bool = Field(True, description="Solo se codifican los códigos activos")

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str) -> str:
        """Normaliza la etiqueta quitando espacios y rechaza etiquetas vacías."""
        v = v.strip()
        if not v:
            raise ValueError("La etiqueta no puede estar vacía")
        return v

    @model_validator(mode="after")
    def _validate_signal(self) -> "Code":
        """Garantiza que el código tenga con qué ser reconocido por el LLM.

        Reglas:
        - Un código ``custom`` siempre exige definición.
        - Cualquier código necesita al menos una señal (definición o ejemplo);
          sin ninguna, el LLM no tendría nada que buscar.
        """
        if self.origin == CodeOrigin.custom and not self.definition.strip():
            raise ValueError(
                f"El código custom '{self.label}' requiere una definición"
            )
        if not self.definition.strip() and not self.examples:
            raise ValueError(
                f"El código '{self.label}' requiere una definición o al menos un ejemplo"
            )
        return self

    # Ejemplo mostrado en Swagger para documentar el esquema del código.
    model_config = {
        "json_schema_extra": {
            "example": {
                "id": "facilitador",
                "label": "Facilitador",
                "definition": "Un facilitador es cualquier condición, recurso o relación que, de manera pasiva, contribuye a que una iniciativa avance...",
                "examples": [
                    {"text": "el acceso a contactos que permiten el uso de recursos", "kind": "positive"}
                ],
                "color": "#2E933C",
                "origin": "base",
                "active": True,
            }
        }
    }
