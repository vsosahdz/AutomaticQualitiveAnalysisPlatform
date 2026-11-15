"""Regresión de la comparación humano vs LLM.

``fixtures/compare_regression.json`` guarda la salida de ``comparison.compare``
ANTES de generalizar el núcleo para la comparación A vs B; el refactor debe
producir exactamente lo mismo.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.models.results import Document
from app.services import comparison
from app.services.human_import import HumanEntry

FIXTURE = Path(__file__).parent / "fixtures" / "compare_regression.json"


def fake_embed(texts):
    """Mismos embeddings deterministas con los que se generó el caso fijo."""
    out = []
    for t in texts:
        low = t.lower()
        out.append([
            float("trabas" in low or "permisos" in low),
            float("alianza" in low or "red" in low),
            float("calor" in low or "agua" in low) + 0.1,
        ])
    return out


def test_compare_output_unchanged(monkeypatch):
    monkeypatch.setattr(comparison.embeddings, "embed_texts", fake_embed)
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    llm = [Document(**d) for d in data["llm"]]
    human = [HumanEntry(**e) for e in data["human"]]
    result = comparison.compare(llm, human)
    assert result.model_dump(mode="json") == data["expected"]
