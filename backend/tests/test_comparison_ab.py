"""Pruebas de la comparación A vs B (métricas simétricas, fuentes y endpoint)."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import coding_sources, comparison
from app.services.comparison import PairDocument, SideItem

TEXT = "Las trabas nos frenaron. Creamos alianzas con actores. El calor afecto la cosecha."


@pytest.fixture(autouse=True)
def fake_embeddings(monkeypatch):
    """Embeddings deterministas por palabra clave."""
    def embed(texts):
        return [[float("trabas" in t), float("alianzas" in t), float("calor" in t) + 0.1] for t in texts]
    monkeypatch.setattr(comparison.embeddings, "embed_texts", embed)


def _doc(items_a, items_b):
    return PairDocument(name="e.txt", full_text=TEXT, items_a=items_a, items_b=items_b)


A_ITEMS = [
    SideItem(code="Barrera", quote="Las trabas nos frenaron."),
    SideItem(code="Estrategia", quote="Creamos alianzas"),
]
B_ITEMS = [
    SideItem(code="Barrera", quote="trabas"),
    SideItem(code="Barrera", quote="El calor afecto la cosecha."),
]


def test_metrics_are_symmetric():
    ab = comparison.compare_ab([_doc(A_ITEMS, B_ITEMS)], "A", "B").documents[0]
    ba = comparison.compare_ab([_doc(B_ITEMS, A_ITEMS)], "B", "A").documents[0]
    assert ab.overall == ba.overall
    by_code = {m.code: m for m in ba.per_code}
    for m in ab.per_code:
        other = by_code[m.code]
        assert (m.kappa, m.observed_agreement, m.positive_agreement) == (
            other.kappa, other.observed_agreement, other.positive_agreement
        )
        assert (m.only_a, m.only_b) == (other.only_b, other.only_a)


def test_metric_values_and_diff():
    doc = comparison.compare_ab([_doc(A_ITEMS, B_ITEMS)], "A", "B").documents[0]
    barrera = {m.code: m for m in doc.per_code}["Barrera"]
    # 3 oraciones: U0 ambos, U2 solo B, U1 ninguno.
    assert (barrera.both, barrera.only_a, barrera.only_b, barrera.neither) == (1, 0, 1, 1)
    assert barrera.observed_agreement == pytest.approx(0.667)
    assert barrera.positive_agreement == pytest.approx(0.667)
    assert [u.status for u in doc.units] == ["agree", "only_a", "only_b"]


def test_unmapped_reported_per_side():
    res = comparison.compare_ab(
        [_doc(A_ITEMS, [SideItem(code="Barrera", quote="no existe en el texto")])], "Ana", "Beto"
    )
    assert res.unmapped_a == []
    assert len(res.unmapped_b) == 1 and res.unmapped_b[0].startswith("Beto")


# --- Fuentes ------------------------------------------------------------------

def _csv(rows, header="document,quotation,codes,comment"):
    return ("\n".join([header, *rows]) + "\n").encode("utf-8")


def _aqa(name, fragments, removed=()):
    return json.dumps({
        "aqa": {"tool": "t", "version": "0.1.0", "kind": "aqa-analysis-export"},
        "document": {"name": name, "full_text": TEXT, "fragments": list(fragments),
                     "removed_fragments": list(removed)},
        "codebook": [],
    }).encode("utf-8")


def _frag(start, end, code, **kw):
    return {"start": start, "end": end, "code": code, "quote": TEXT[start:end],
            "justification": "", **kw}


def test_doc_key_ignores_case_and_extension():
    assert coding_sources.doc_key("Entrevista_01.TXT") == coding_sources.doc_key("entrevista_01")


def test_edited_json_ignores_removed_fragments():
    side = coding_sources.load_side([(
        "e_AQA.json",
        _aqa("e.txt", [_frag(0, 24, "Barrera", origin="editado")],
             removed=[_frag(25, 41, "Estrategia")]),
    )])
    assert [i.code for i in side.items["e"]] == ["Barrera"]
    assert side.texts["e"] == TEXT


def test_mixing_csv_and_json_in_one_side_is_rejected():
    with pytest.raises(ValueError):
        coding_sources.load_side([("a.csv", _csv([])), ("b.json", _aqa("e.txt", []))])


def test_single_documents_match_even_if_names_differ():
    side_a = coding_sources.load_side([("a.csv", _csv(['Entrevista 1,trabas,Barrera,']))])
    side_b = coding_sources.load_side([("e_AQA.json", _aqa("e.txt", [_frag(0, 24, "Barrera")]))])
    docs, missing, _ = coding_sources.assemble(side_a, side_b, {})
    assert missing == []
    assert len(docs) == 1 and docs[0].name == "e.txt"
    assert len(docs[0].items_a) == 1 and len(docs[0].items_b) == 1


def test_documents_without_text_are_reported():
    side_a = coding_sources.load_side([("a.csv", _csv(["e1,trabas,Barrera,", "e2,algo,Barrera,"]))])
    side_b = coding_sources.load_side([("b.csv", _csv(["e1,trabas,Barrera,", "e2,algo,Barrera,"]))])
    transcripts = coding_sources.load_transcripts([("e1.txt", TEXT.encode("utf-8"))])
    docs, missing, _ = coding_sources.assemble(side_a, side_b, transcripts)
    assert [d.name for d in docs] == ["e1.txt"]
    assert missing == ["e2"]


# --- Endpoint -----------------------------------------------------------------

client = TestClient(app)


def test_endpoint_two_human_codings_with_transcript():
    res = client.post(
        "/compare/ab",
        files=[
            ("a_files", ("ana.csv", _csv(["e,Las trabas nos frenaron.,Barrera,c"]), "text/csv")),
            ("b_files", ("beto.csv", _csv(["e,trabas,Factor,"]), "text/csv")),
            ("transcripts", ("e.txt", TEXT.encode("utf-8"), "text/plain")),
        ],
        data={"a_label": "Ana", "b_label": "Beto"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["a_label"], body["b_label"]) == ("Ana", "Beto")
    doc = body["documents"][0]
    # "Factor" se normaliza a Barrera y coincide en la primera oración.
    assert doc["per_code"][0]["code"] == "Barrera" and doc["per_code"][0]["both"] == 1
    assert doc["a_fragments"][0]["comment"] == "c"


def test_endpoint_without_text_returns_422():
    res = client.post(
        "/compare/ab",
        files=[
            ("a_files", ("a.csv", _csv(["e,trabas,Barrera,"]), "text/csv")),
            ("b_files", ("b.csv", _csv(["e,trabas,Barrera,"]), "text/csv")),
        ],
    )
    assert res.status_code == 422
    assert "transcripción" in res.json()["detail"]
