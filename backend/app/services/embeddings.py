"""Embeddings de texto vía Ollama y similitud del coseno (comparación semántica).

Usa un modelo de embeddings local (por defecto ``bge-m3``) a través de la API de
Ollama para representar las citas como vectores y compararlas por coseno. Se usa
en la Fase II para reconocer el "mismo hallazgo" aunque el texto difiera.
"""
from __future__ import annotations

import math
from typing import List

import httpx

from app.core import config


class EmbeddingError(RuntimeError):
    """Error al obtener embeddings del servidor de Ollama."""


def embed_texts(texts: List[str]) -> List[List[float]]:
    """Devuelve el embedding de cada texto usando el modelo configurado.

    Args:
        texts: lista de textos a embeber.

    Returns:
        Lista de vectores (uno por texto, en el mismo orden).

    Raises:
        EmbeddingError: si el servidor de embeddings no responde correctamente.
    """
    if not texts:
        return []
    url = f"{config.OLLAMA_HOST}/api/embed"
    payload = {"model": config.EMBEDDING_MODEL, "input": texts}
    try:
        with httpx.Client(timeout=config.LLM_TIMEOUT_SECONDS) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise EmbeddingError(f"No se pudieron obtener embeddings: {exc}") from exc
    embeddings = data.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise EmbeddingError("Respuesta de embeddings inesperada")
    return embeddings


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Calcula la similitud del coseno entre dos vectores (0 si alguno es nulo)."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
