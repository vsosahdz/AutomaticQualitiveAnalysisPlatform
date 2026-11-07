"""Pruebas de la comparación humano vs LLM (léxico + semántico simulado)."""
from __future__ import annotations

from app.models.results import Document, Fragment
from app.services import comparison, human_import
from app.services.human_import import HumanEntry


# Texto con 3 oraciones (U0, U1, U2).
TEXT = "Las trabas burocraticas nos frenaron. Creamos alianzas con actores. El calor afecto la cosecha."


def _llm_doc():
    # LLM: U0 Barrera, U1 Estrategia (por offsets exactos de las oraciones).
    from app.services.segmentation import segment
    u = segment(TEXT)
    return Document(
        name="e.txt",
        full_text=TEXT,
        fragments=[
            Fragment(start=u[0].start, end=u[0].end, code="Barrera", quote=u[0].text, justification="j0"),
            Fragment(start=u[1].start, end=u[1].end, code="Estrategia", quote=u[1].text, justification="j1"),
        ],
    )


def _patch_embeddings(monkeypatch):
    """Embeddings deterministas: vector por texto según su código base."""
    def fake_embed(texts):
        # Cada texto -> vector unitario en una dimensión según palabra clave.
        vecs = []
        for t in texts:
            if "trabas" in t:
                vecs.append([1.0, 0.0, 0.0])
            elif "alianzas" in t:
                vecs.append([0.0, 1.0, 0.0])
            else:
                vecs.append([0.0, 0.0, 1.0])
        return vecs
    monkeypatch.setattr(comparison.embeddings, "embed_texts", fake_embed)


def test_lexical_metrics_and_diff(monkeypatch):
    """Humano marca U0 Barrera (coincide) y U2 Facilitador (solo humano)."""
    _patch_embeddings(monkeypatch)
    human = [
        HumanEntry(document="e.txt", quotation="Las trabas burocraticas nos frenaron.", code="Barrera"),
        HumanEntry(document="e.txt", quotation="El calor afecto la cosecha.", code="Facilitador"),
    ]
    res = comparison.compare([_llm_doc()], human)
    doc = res.documents[0]
    codes = {m.code: m for m in doc.per_code}
    # Barrera: U0 en ambos -> TP=1.
    assert codes["Barrera"].tp == 1 and codes["Barrera"].fp == 0
    # Estrategia: solo LLM en U1 -> FP=1 (humano no lo puso).
    assert codes["Estrategia"].fp == 1 and codes["Estrategia"].tp == 0
    # Facilitador: solo humano en U2 -> FN=1.
    assert codes["Facilitador"].fn == 1
    # Diff por oración.
    by_start = {d.start: d for d in doc.units}
    assert by_start[doc.units[0].start].status in ("agree", "only_human", "only_llm", "partial", "none")


def test_semantic_only_ai(monkeypatch):
    """La Estrategia del LLM (U1) no tiene equivalente humano -> baja similitud."""
    _patch_embeddings(monkeypatch)
    human = [HumanEntry(document="e.txt", quotation="Las trabas burocraticas nos frenaron.", code="Barrera")]
    res = comparison.compare([_llm_doc()], human)
    doc = res.documents[0]
    sims = {f.code: f.max_similarity for f in doc.llm_fragments}
    # Barrera del LLM coincide con la cita humana (mismo vector) -> similitud alta.
    assert sims["Barrera"] >= 0.99
    # Estrategia no tiene equivalente humano -> similitud baja (novedoso, solo-IA).
    assert sims["Estrategia"] <= 0.01


def test_unmapped_quotation(monkeypatch):
    """Una cita humana que no está en el texto se reporta como no mapeada."""
    _patch_embeddings(monkeypatch)
    human = [HumanEntry(document="e.txt", quotation="Esta frase no existe en el texto.", code="Barrera")]
    res = comparison.compare([_llm_doc()], human)
    assert len(res.unmapped) == 1


def test_normalize_human_codes():
    """Normalización de códigos humanos hacia el codebook canónico."""
    from app.services.human_import import normalize_code
    assert normalize_code("Factor") == "Barrera"
    assert normalize_code("factores limitantes") == "Barrera"
    assert normalize_code("Facilitador") == "Facilitador"
    assert normalize_code("facilitadores") == "Facilitador"
    assert normalize_code("Estrategias") == "Estrategia"
    assert normalize_code("BARRERA") == "Barrera"
    assert normalize_code("") is None
    assert normalize_code("   ") is None
    # Etiquetado pero sin coincidencia con el codebook → se conserva.
    assert normalize_code("Gobernanza") == "Gobernanza"


def test_blank_codes_row_ignored():
    """Una fila con la columna codes en blanco se ignora."""
    from app.services import human_import
    csv_bytes = (
        "document,quotation,codes,comment\n"
        "e.txt,\"una cita cualquiera\",,sin codigo\n"
        "e.txt,\"otra cita\",Factor,con codigo\n"
    ).encode("utf-8")
    entries = human_import.parse_csv(csv_bytes)
    assert len(entries) == 1
    assert entries[0].code == "Barrera"  # 'Factor' -> Barrera


def test_csv_parsing_multiple_codes():
    """El CSV con varios códigos en una cita genera una entrada por código."""
    csv_bytes = (
        "document,quotation,codes,comment\n"
        "e.txt,\"Creamos alianzas con actores.\",\"Estrategia, Facilitador\",un comentario\n"
    ).encode("utf-8")
    entries = human_import.parse_csv(csv_bytes)
    assert len(entries) == 2
    assert {e.code for e in entries} == {"Estrategia", "Facilitador"}
    assert all(e.comment == "un comentario" for e in entries)
