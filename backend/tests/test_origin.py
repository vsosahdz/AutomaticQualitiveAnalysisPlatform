"""Pruebas del origen de los fragmentos (llm / editado / manual)."""
from __future__ import annotations

import csv
import io

from app.models.results import Document, Fragment, FragmentOrigin, Result
from app.services import csv_export

TEXT = "Las trabas nos frenaron. Creamos alianzas."


def test_fragment_without_origin_defaults_to_llm():
    """Un JSON exportado antes de existir el origen se valida como 'llm'."""
    raw = {
        "name": "e.txt",
        "full_text": TEXT,
        "fragments": [
            {"start": 0, "end": 24, "code": "Barrera", "quote": TEXT[0:24], "justification": "j"}
        ],
    }
    doc = Document(**raw)
    assert doc.fragments[0].origin == FragmentOrigin.llm
    assert doc.fragments[0].original is None
    assert doc.removed_fragments == []


def test_result_json_includes_origin():
    """El resultado serializado expone origin='llm' en cada fragmento."""
    doc = Document(
        name="e.txt",
        full_text=TEXT,
        fragments=[Fragment(start=0, end=24, code="Barrera", quote=TEXT[0:24])],
    )
    dumped = Result(documents=[doc]).model_dump(mode="json")
    assert dumped["documents"][0]["fragments"][0]["origin"] == "llm"
    assert dumped["documents"][0]["removed_fragments"] == []


def _rows(text: str):
    return list(csv.reader(io.StringIO(text)))


def test_csv_without_edits_keeps_four_columns():
    doc = Document(
        name="e.txt",
        full_text=TEXT,
        fragments=[Fragment(start=0, end=24, code="Barrera", quote=TEXT[0:24])],
    )
    rows = _rows(csv_export.result_to_csv(Result(documents=[doc])))
    assert rows[0] == ["archivo", "cita", "codigo", "justificacion"]


def test_csv_with_edits_adds_origin_column_and_skips_removed():
    removed = Fragment(start=25, end=42, code="Estrategia", quote=TEXT[25:42])
    doc = Document(
        name="e.txt",
        full_text=TEXT,
        fragments=[
            Fragment(start=0, end=24, code="Barrera", quote=TEXT[0:24]),
            Fragment(start=4, end=10, code="Facilitador", quote=TEXT[4:10], origin="manual"),
        ],
        removed_fragments=[removed],
    )
    rows = _rows(csv_export.result_to_csv(Result(documents=[doc])))
    assert rows[0] == ["archivo", "cita", "codigo", "justificacion", "origen"]
    assert [r[4] for r in rows[1:]] == ["llm", "manual"]
    assert all(r[2] != "Estrategia" for r in rows[1:])


def test_csv_removed_only_still_counts_as_edited():
    """Eliminar sin agregar ni modificar también marca el resultado como editado."""
    doc = Document(
        name="e.txt",
        full_text=TEXT,
        fragments=[Fragment(start=0, end=24, code="Barrera", quote=TEXT[0:24])],
        removed_fragments=[Fragment(start=25, end=42, code="Estrategia", quote=TEXT[25:42])],
    )
    rows = _rows(csv_export.result_to_csv(Result(documents=[doc])))
    assert rows[0][-1] == "origen"
