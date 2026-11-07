"""Proveedor de LLM local basado en Ollama.

Implementa :class:`LLMProvider` llamando a la API HTTP de Ollama
(``/api/generate``) con ``format: json`` y temperatura baja, reintentando de
forma acotada ante respuestas inválidas.
"""
from __future__ import annotations

from typing import List, Optional

import httpx

from app.core import config
from app.models.code import Code
from app.services.llm.base import (
    LLMError,
    LLMProvider,
    RawCoding,
    build_output_schema,
    build_prompt,
    parse_response,
)
from app.services.segmentation import Unit


def list_ollama_models(host: Optional[str] = None) -> List[str]:
    """Lista los modelos disponibles en el servidor Ollama.

    Args:
        host: URL del servidor (por defecto, ``config.OLLAMA_HOST``).

    Returns:
        Nombres de los modelos descargados; lista vacía si el servidor no responde.
    """
    base = host or config.OLLAMA_HOST
    try:
        with httpx.Client(timeout=5) as client:
            resp = client.get(f"{base}/api/tags")
            resp.raise_for_status()
            data = resp.json()
        names = [m["name"] for m in data.get("models", []) if "name" in m]
        # Excluye modelos de embeddings (no sirven para generación de texto).
        return [n for n in names if not _is_embedding_model(n)]
    except (httpx.HTTPError, KeyError, ValueError):
        return []


def _is_embedding_model(name: str) -> bool:
    """Heurística para descartar modelos de embeddings del listado de chat."""
    low = name.lower()
    return any(tok in low for tok in ("embed", "bge-", "nomic-embed", "minilm"))


class OllamaProvider(LLMProvider):
    """Proveedor que ejecuta el modelo localmente vía Ollama."""

    def __init__(
        self,
        host: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        """Crea el proveedor.

        Args:
            host: URL del servidor Ollama (por defecto, ``config.OLLAMA_HOST``).
            model: nombre del modelo (por defecto, ``config.OLLAMA_MODEL``).
        """
        self.host = host or config.OLLAMA_HOST
        self.model = model or config.OLLAMA_MODEL

    def code_units(self, units: List[Unit], codebook: List[Code]) -> List[RawCoding]:
        """Codifica una ventana de unidades con el modelo local (ver base)."""
        if not units:
            return []

        prompt = build_prompt(units, codebook)
        url = f"{self.host}/api/generate"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            # Salida estructurada: se pasa el JSON Schema (con `code` como enum)
            # para que Ollama restrinja la forma y no se puedan inventar códigos.
            "format": build_output_schema(codebook),
            # think=false desactiva el razonamiento en modelos que lo soporten
            # (los que no, lo ignoran) → menos tokens por llamada, más rápido.
            "think": config.OLLAMA_THINK,
            # Mantiene el modelo cargado entre ventanas/documentos (evita recargas).
            "keep_alive": config.OLLAMA_KEEP_ALIVE,
            "options": {
                "temperature": config.LLM_TEMPERATURE,
                # Contexto acotado: menos memoria y menor tiempo de prefill.
                "num_ctx": config.OLLAMA_NUM_CTX,
            },
        }

        last_error: Optional[Exception] = None
        # Un intento inicial + LLM_MAX_RETRIES reintentos ante fallo de red o JSON.
        for _ in range(config.LLM_MAX_RETRIES + 1):
            try:
                with httpx.Client(timeout=config.LLM_TIMEOUT_SECONDS) as client:
                    resp = client.post(url, json=payload)
                    resp.raise_for_status()
                    content = resp.json().get("response", "")
                return parse_response(content)
            except (httpx.HTTPError, LLMError) as exc:
                last_error = exc
                continue
        raise LLMError(f"No se pudo codificar la ventana con Ollama: {last_error}")
