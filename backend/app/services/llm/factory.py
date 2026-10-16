"""Fábrica que selecciona el proveedor de LLM según la configuración.

Este es el único lugar que conoce las implementaciones concretas. Para añadir un
proveedor en la nube en el futuro, basta crear su clase (que implemente
:class:`LLMProvider`) y registrarla aquí bajo una clave de ``LLM_PROVIDER``.
"""
from __future__ import annotations

from typing import Optional

from app.core import config
from app.services.llm.base import LLMProvider
from app.services.llm.ollama_provider import OllamaProvider, list_ollama_models


def get_provider(model: Optional[str] = None) -> LLMProvider:
    """Devuelve la instancia de :class:`LLMProvider` configurada.

    Selecciona según ``config.LLM_PROVIDER``.

    Args:
        model: modelo a usar; si es ``None``, se usa el configurado por defecto.

    Returns:
        Un proveedor de LLM listo para usar.

    Raises:
        ValueError: si el proveedor configurado no existe o aún no está
            implementado (p. ej. 'cloud').
    """
    provider = config.LLM_PROVIDER.strip().lower()
    if provider == "ollama":
        return OllamaProvider(model=model)
    if provider == "cloud":
        # Punto de extensión: aquí se instanciaría el proveedor en la nube usando
        # config.CLOUD_LLM_BASE_URL / CLOUD_LLM_API_KEY / CLOUD_LLM_MODEL.
        raise ValueError(
            "El proveedor 'cloud' aún no está implementado; usa LLM_PROVIDER=ollama"
        )
    raise ValueError(f"Proveedor de LLM desconocido: '{config.LLM_PROVIDER}'")


def list_models() -> list[str]:
    """Lista los modelos disponibles según el proveedor configurado.

    Returns:
        Nombres de modelos disponibles. Para 'ollama', consulta el servidor;
        para otros proveedores, devuelve el modelo configurado (si lo hay).
    """
    provider = config.LLM_PROVIDER.strip().lower()
    if provider == "ollama":
        return list_ollama_models()
    if provider == "cloud" and config.CLOUD_LLM_MODEL:
        return [config.CLOUD_LLM_MODEL]
    return []
