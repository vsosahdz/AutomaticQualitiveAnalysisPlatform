"""Pruebas del pipeline de codificación con un proveedor de LLM stub.

Se inyecta un :class:`LLMProvider` falso para probar validación, resolución de
offsets, multicódigo y descartes sin depender de Ollama.
"""
from __future__ import annotations

from typing import List

from app.models.code import Code, CodeOrigin
from app.services import coding, csv_export
from app.models.results import Result
from app.services.llm import RawCoding
from app.services.segmentation import Unit


class StubProvider:
    """Proveedor falso que devuelve codificaciones predefinidas por índice de unidad.

    Mapea el texto de cada unidad a una respuesta fija para hacer las pruebas
    deterministas.
    """

    def __init__(self, codings: List[RawCoding]):
        self._codings = codings

    def code_units(self, units, codebook):
        # Devuelve las codificaciones predefinidas tal cual (incluidas las que
        # referencian IDs inexistentes, como haría un LLM que alucina un ID). El
        # pipeline se encarga de validarlas y deduplicar entre ventanas.
        return list(self._codings)


def _codebook() -> List[Code]:
    return [
        Code(id="barrera", label="Barrera", definition="d", origin=CodeOrigin.base),
        Code(id="estrategia", label="Estrategia", definition="d", origin=CodeOrigin.base),
    ]


def test_fragment_offsets_match_quote():
    """El fragmento resuelto debe tener ``quote == full_text[start:end]``."""
    text = "Las trabas burocráticas nos frenaron. Creamos alianzas con otros actores."
    stub = StubProvider([RawCoding(0, 0, "Barrera", "es una barrera")])
    doc, dropped = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    assert len(doc.fragments) == 1
    frag = doc.fragments[0]
    assert frag.quote == text[frag.start : frag.end]
    assert frag.code == "Barrera"


def test_multicode_produces_separate_fragments():
    """Un mismo tramo con dos códigos produce dos fragmentos separados."""
    text = "Creamos alianzas con otros actores."
    stub = StubProvider(
        [
            RawCoding(0, 0, "Estrategia", "acción deliberada"),
            RawCoding(0, 0, "Barrera", "otra lectura"),
        ]
    )
    doc, _ = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    assert len(doc.fragments) == 2
    assert {f.code for f in doc.fragments} == {"Estrategia", "Barrera"}


def test_invalid_code_is_dropped():
    """Un código inventado por el LLM se descarta y se registra."""
    text = "Una oración cualquiera."
    stub = StubProvider([RawCoding(0, 0, "Inventado", "x")])
    doc, dropped = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    assert doc.fragments == []
    assert len(dropped) == 1
    assert "no presente" in dropped[0].reason.lower()


def test_out_of_range_unit_is_dropped():
    """Un ID de unidad fuera de rango se descarta y se registra."""
    text = "Una sola oración."
    stub = StubProvider([RawCoding(99, 99, "Barrera", "x")])
    doc, dropped = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    assert doc.fragments == []
    assert len(dropped) == 1
    assert "fuera de rango" in dropped[0].reason.lower()


def test_same_code_nested_overlaps_merge():
    """Dos fragmentos del mismo código anidados/solapados se fusionan en su unión."""
    text = "Primera oración larga aquí. Segunda parte de la idea. Tercera cosa."
    stub = StubProvider(
        [
            RawCoding(0, 2, "Barrera", "rango amplio"),   # cubre U0..U2
            RawCoding(1, 1, "Barrera", "sub-rango anidado"),  # dentro del anterior
        ]
    )
    doc, _ = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    barreras = [f for f in doc.fragments if f.code == "Barrera"]
    assert len(barreras) == 1  # se fusionaron en uno
    assert barreras[0].quote == text[barreras[0].start : barreras[0].end]


def test_different_codes_overlap_not_merged():
    """Un solape entre códigos DISTINTOS no se fusiona (es un empalme legítimo)."""
    text = "Creamos alianzas con otros actores de la comunidad."
    stub = StubProvider(
        [
            RawCoding(0, 0, "Estrategia", "acción"),
            RawCoding(0, 0, "Barrera", "otra lectura"),
        ]
    )
    doc, _ = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    assert len(doc.fragments) == 2
    assert {f.code for f in doc.fragments} == {"Estrategia", "Barrera"}


def test_csv_has_four_columns_and_one_row_per_fragment():
    """El CSV derivado tiene 4 columnas y una fila por fragmento (+ encabezado)."""
    text = "Creamos alianzas con otros actores."
    stub = StubProvider(
        [
            RawCoding(0, 0, "Estrategia", "acción"),
            RawCoding(0, 0, "Barrera", "otra"),
        ]
    )
    doc, dropped = coding.code_document("e1.txt", text, _codebook(), provider=stub)
    csv_text = csv_export.result_to_csv(Result(documents=[doc], dropped=dropped))
    lines = [ln for ln in csv_text.splitlines() if ln.strip()]
    assert lines[0] == "archivo,cita,codigo,justificacion"
    assert len(lines) == 1 + 2  # encabezado + 2 fragmentos
