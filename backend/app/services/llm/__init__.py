"""Paquete de proveedores de LLM.

Expone la interfaz, los tipos compartidos y la fábrica para que el resto del
backend importe desde ``app.services.llm`` sin acoplarse a una implementación.
"""
from app.services.llm.base import LLMError, LLMProvider, RawCoding
from app.services.llm.factory import get_provider, list_models

__all__ = ["LLMProvider", "RawCoding", "LLMError", "get_provider", "list_models"]
