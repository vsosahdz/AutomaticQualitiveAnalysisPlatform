"""Pruebas de la segmentación: la invariante de offsets es lo crítico."""
from __future__ import annotations

from app.services.segmentation import segment


def test_offsets_reconstruct_original_text():
    """Cada unidad debe cumplir ``text[start:end] == unit.text`` (offsets exactos)."""
    text = (
        "ENTREVISTADOR: ¿Cuáles fueron las barreras?\n"
        "ENTREVISTADO: Las trabas burocráticas nos frenaron. "
        "Creamos alianzas con otros actores. El calor también afectó."
    )
    units = segment(text)
    assert units, "debe producir al menos una unidad"
    for u in units:
        assert text[u.start : u.end] == u.text


def test_ids_are_sequential_and_unique():
    """Los IDs deben ser 0..n-1, únicos y en orden."""
    text = "Primera oración. Segunda oración. Tercera oración."
    units = segment(text)
    ids = [u.id for u in units]
    assert ids == list(range(len(units)))


def test_abbreviations_do_not_split():
    """Un punto de abreviatura (p. ej. 'Dr.') no debe cortar la oración."""
    text = "El Dr. García llegó tarde a la reunión."
    units = segment(text)
    # Debe quedar como una sola oración, no partirse en "El Dr." + resto.
    assert len(units) == 1
    assert units[0].text == text


def test_speaker_marker_starts_new_unit():
    """Un cambio de hablante inicia una nueva unidad."""
    text = "ENTREVISTADO: Hola. ENTREVISTADOR: Buenas."
    units = segment(text)
    joined = " ".join(u.text for u in units)
    assert "ENTREVISTADO:" in units[0].text
    assert any("ENTREVISTADOR:" in u.text for u in units)
    # Se conservan las marcas (no se pierden caracteres relevantes).
    assert "ENTREVISTADOR:" in joined
