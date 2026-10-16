"""Pruebas del consenso, simulando distintos modelos con code_document."""
from __future__ import annotations

from typing import List

import pytest

from app.models.code import Code, CodeOrigin
from app.models.results import Document, Fragment
from app.services import consensus


def _codebook() -> List[Code]:
    return [
        Code(id="barrera", label="Barrera", definition="d", origin=CodeOrigin.base),
        Code(id="estrategia", label="Estrategia", definition="d", origin=CodeOrigin.base),
    ]


# Texto con 3 oraciones (U0, U1, U2).
TEXT = "Primera oración aquí. Segunda oración distinta. Tercera y última."


def _fake_code_document_factory(per_model):
    """Crea un code_document falso que devuelve fragmentos según el modelo.

    per_model: dict modelo -> lista de (code, unit_index) que ese modelo asigna.
    Mapea cada índice de oración a su span exacto vía segmentación real.
    """
    from app.services.segmentation import segment

    units = segment(TEXT)

    def fake(name, text, codebook, provider=None, progress=None, should_cancel=None, merge_overlaps=True):
        model = getattr(provider, "model", "?")
        frags = []
        for code, uidx in per_model.get(model, []):
            u = units[uidx]
            frags.append(
                Fragment(start=u.start, end=u.end, code=code, quote=u.text, justification=f"{model}:{code}")
            )
        return Document(name=name, full_text=text, fragments=frags), []

    return fake


class _P:
    def __init__(self, model):
        self.model = model


def test_majority_keeps_agreed_and_drops_minority(monkeypatch):
    """2 de 3 conservan; 1 de 3 se descarta."""
    # U0: A,B,C -> Barrera (3/3). U1: A,B -> Estrategia (2/3). U2: solo C -> Barrera (1/3).
    per_model = {
        "A": [("Barrera", 0), ("Estrategia", 1)],
        "B": [("Barrera", 0), ("Estrategia", 1)],
        "C": [("Barrera", 0), ("Barrera", 2)],
    }
    monkeypatch.setattr(consensus.coding, "code_document", _fake_code_document_factory(per_model))
    monkeypatch.setattr(consensus, "get_provider", lambda m: _P(m))

    doc, _ = consensus.code_document_consensus("e.txt", TEXT, _codebook(), ["A", "B", "C"])
    got = {(f.code, tuple(f.models)) for f in doc.fragments}
    # U0 Barrera con 3 modelos, U1 Estrategia con 2 modelos; U2 (1/3) descartado.
    assert ("Barrera", ("A", "B", "C")) in got
    assert ("Estrategia", ("A", "B")) in got
    assert all(not (f.code == "Barrera" and f.start == 0 and len(f.models) == 1) for f in doc.fragments)
    # No debe existir ningún fragmento con un solo modelo (minoría).
    assert all(len(f.models) >= 2 for f in doc.fragments)


def test_threshold():
    """Umbral de mayoría: 2 de 2, 2 de 3."""
    assert consensus.majority_threshold(2) == 2
    assert consensus.majority_threshold(3) == 2
