"""Comparación de codificaciones: capa léxica (acuerdo) y semántica (similitud).

Alinea dos codificaciones del mismo documento a nivel de (oración, código) y usa
embeddings de las citas para la capa semántica, que permite reconocer el mismo
hallazgo aunque el texto difiera y detectar hallazgos exclusivos de un lado.

Un núcleo genérico compara dos lados (A y B) y lo usan dos variantes:

- **humano vs LLM** (:func:`compare`): el humano es la referencia (P/R/F1 y
  Cohen's kappa); conserva el contrato de ``POST /compare``.
- **A vs B** (:func:`compare_ab`): dos codificaciones cualesquiera, con métricas
  simétricas (kappa, acuerdo observado y acuerdo específico positivo).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from app.core import config
from app.models.comparison import (
    CodeMetric,
    ComparisonResult,
    DocumentComparison,
    FragmentSim,
    OverallMetrics,
    PairCodeMetric,
    PairComparisonResult,
    PairDocumentComparison,
    PairOverallMetrics,
    PairUnitDiff,
    UnitDiff,
)
from app.models.results import Document
from app.services import embeddings
from app.services.human_import import HumanEntry
from app.services.segmentation import Unit, segment


# --- Fragmento ya mapeado a offsets del texto -------------------------------
class _Span:
    """Un fragmento con offsets, código y texto (de cualquiera de los lados)."""

    def __init__(
        self,
        start: int,
        end: int,
        code: str,
        quote: str,
        extra: str = "",
        note_field: str = "justification",
    ):
        self.start = start
        self.end = end
        self.code = code
        self.quote = quote
        self.extra = extra  # justificación (LLM/JSON) o comentario (humano)
        # Campo de FragmentSim donde va ``extra``: "justification" o "comment".
        self.note_field = note_field


def _normalize_ws(text: str) -> str:
    """Colapsa espacios en blanco para una búsqueda de subcadena tolerante."""
    return re.sub(r"\s+", " ", text).strip()


def _find_span(full_text: str, quotation: str) -> Optional[Tuple[int, int]]:
    """Localiza una cita en el texto y devuelve sus offsets, o None si no está.

    Intenta coincidencia exacta y, si falla, una búsqueda normalizada por espacios
    sobre una versión del texto con el mismo mapeo de posiciones.
    """
    if not quotation:
        return None
    idx = full_text.find(quotation)
    if idx != -1:
        return idx, idx + len(quotation)
    # Búsqueda tolerante a espacios: normaliza ambos y ubica por palabras clave.
    norm_q = _normalize_ws(quotation)
    norm_full = _normalize_ws(full_text)
    pos = norm_full.find(norm_q)
    if pos == -1:
        return None
    # Aproxima el offset en el texto original por proporción de longitud.
    # (suficiente para resaltar; el acuerdo léxico usa oraciones completas)
    approx = full_text.find(norm_q[:20].split(" ")[0]) if norm_q else -1
    if approx != -1:
        return approx, min(approx + len(quotation), len(full_text))
    return None


def _units_covered(units: List[Unit], start: int, end: int) -> List[int]:
    """IDs de las unidades que SOLAPAN el rango [start, end).

    Se usa solape (no contención) para que tanto los spans que abarcan oraciones
    completas (LLM) como las citas sub-oración (humanas) queden asociados a la(s)
    oración(es) correspondiente(s).
    """
    return [u.id for u in units if u.start < end and start < u.end]


def _kappa(a: int, b: int, c: int, d: int) -> Optional[float]:
    """Cohen's kappa binario a partir de la tabla 2x2 (a=ambos sí ... d=ambos no)."""
    n = a + b + c + d
    if n == 0:
        return None
    po = (a + d) / n
    p_yes = ((a + b) / n) * ((a + c) / n)
    p_no = ((c + d) / n) * ((b + d) / n)
    pe = p_yes + p_no
    if pe >= 1.0:
        return 1.0 if po >= 1.0 else 0.0
    return (po - pe) / (1 - pe)


def _prf(tp: int, fp: int, fn: int) -> Tuple[float, float, float]:
    """Precisión, recall y F1 a partir de TP/FP/FN."""
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f


def _round_opt(x: Optional[float]) -> Optional[float]:
    """Redondea un valor opcional a 3 decimales."""
    return None if x is None else round(x, 3)


# --- Núcleo genérico: alineación de dos lados por (oración, código) ---------
@dataclass
class _Table:
    """Tabla 2x2 de un código sobre las oraciones del documento."""

    both: int = 0    # a: ambos lados marcan la oración con el código
    only_a: int = 0  # b: solo el lado A
    only_b: int = 0  # c: solo el lado B
    neither: int = 0  # d: ninguno

    def add(self, other: "_Table") -> None:
        self.both += other.both
        self.only_a += other.only_a
        self.only_b += other.only_b
        self.neither += other.neither

    def kappa(self) -> Optional[float]:
        return _kappa(self.both, self.only_a, self.only_b, self.neither)


@dataclass
class _UnitAlignment:
    """Códigos de cada lado en una oración y su estado de acuerdo."""

    unit: Unit
    a: List[str]
    b: List[str]
    status: str  # agree | only_a | only_b | partial | none


@dataclass
class _Alignment:
    """Resultado de alinear dos lados sobre las oraciones de un documento."""

    codes: List[str]
    tables: Dict[str, _Table] = field(default_factory=dict)
    units: List[_UnitAlignment] = field(default_factory=list)


def _align(units: List[Unit], spans_a: List[_Span], spans_b: List[_Span]) -> _Alignment:
    """Alinea dos codificaciones a nivel de (oración, código)."""
    a_by_unit: Dict[int, Set[str]] = {u.id: set() for u in units}
    b_by_unit: Dict[int, Set[str]] = {u.id: set() for u in units}
    for s in spans_a:
        for uid in _units_covered(units, s.start, s.end):
            a_by_unit[uid].add(s.code)
    for s in spans_b:
        for uid in _units_covered(units, s.start, s.end):
            b_by_unit[uid].add(s.code)

    codes = sorted({s.code for s in spans_a} | {s.code for s in spans_b})
    alignment = _Alignment(codes=codes)
    for code in codes:
        t = _Table()
        for u in units:
            in_a = code in a_by_unit[u.id]
            in_b = code in b_by_unit[u.id]
            if in_a and in_b:
                t.both += 1
            elif in_a:
                t.only_a += 1
            elif in_b:
                t.only_b += 1
            else:
                t.neither += 1
        alignment.tables[code] = t

    for u in units:
        a = sorted(a_by_unit[u.id])
        b = sorted(b_by_unit[u.id])
        if not a and not b:
            status = "none"
        elif set(a) == set(b):
            status = "agree"
        elif a and not b:
            status = "only_a"
        elif b and not a:
            status = "only_b"
        else:
            status = "partial"
        alignment.units.append(_UnitAlignment(unit=u, a=a, b=b, status=status))
    return alignment


def _fragment_sim(s: _Span, sim: float, quote: str, code: str) -> FragmentSim:
    """Construye el FragmentSim de un span con su mejor coincidencia del otro lado."""
    return FragmentSim(
        code=s.code, quote=s.quote, start=s.start, end=s.end,
        max_similarity=round(sim, 3), best_match_quote=quote, best_match_code=code,
        **{s.note_field: s.extra},
    )


def _semantic(
    spans_x: List[_Span], spans_y: List[_Span]
) -> Tuple[List[FragmentSim], List[FragmentSim]]:
    """Calcula, por fragmento, la máxima similitud del coseno con el otro lado.

    Embebe todas las citas de una sola vez y devuelve los fragmentos de cada lado
    con su similitud máxima al lado contrario.
    """
    vecs = embeddings.embed_texts([s.quote for s in spans_x] + [s.quote for s in spans_y])
    x_vecs = vecs[: len(spans_x)]
    y_vecs = vecs[len(spans_x):]

    def best(v, others: List[_Span], other_vecs) -> Tuple[float, str, str]:
        """Devuelve (mejor_similitud, cita, código) del span más parecido."""
        best_sim, best_span = 0.0, None
        for span, ov in zip(others, other_vecs):
            sim = embeddings.cosine_similarity(v, ov)
            if sim >= best_sim:
                best_sim, best_span = sim, span
        if best_span is None:
            return 0.0, "", ""
        return best_sim, best_span.quote, best_span.code

    x_frags = [_fragment_sim(s, *best(x_vecs[i], spans_y, y_vecs)) for i, s in enumerate(spans_x)]
    y_frags = [_fragment_sim(s, *best(y_vecs[i], spans_x, x_vecs)) for i, s in enumerate(spans_y)]
    return x_frags, y_frags


# --- Humano vs LLM -----------------------------------------------------------
# Estados del diff en el contrato humano vs LLM (A = humano, B = LLM).
_HUMAN_LLM_STATUS = {"only_a": "only_human", "only_b": "only_llm"}


def _lexical(
    units: List[Unit], llm: List[_Span], human: List[_Span]
) -> Tuple[List[CodeMetric], OverallMetrics, List[UnitDiff]]:
    """Métricas léxicas con el humano como referencia y diff por oración."""
    alignment = _align(units, human, llm)
    per_code: List[CodeMetric] = []
    total = _Table()
    for code in alignment.codes:
        t = alignment.tables[code]
        # Humano = referencia: TP = ambos, FP = solo LLM, FN = solo humano.
        p, r, f = _prf(t.both, t.only_b, t.only_a)
        per_code.append(
            CodeMetric(code=code, tp=t.both, fp=t.only_b, fn=t.only_a, precision=round(p, 3),
                       recall=round(r, 3), f1=round(f, 3), kappa=_round_opt(t.kappa()))
        )
        total.add(t)

    p, r, f = _prf(total.both, total.only_b, total.only_a)
    overall = OverallMetrics(precision=round(p, 3), recall=round(r, 3),
                             f1=round(f, 3), kappa=_round_opt(total.kappa()))

    diffs = [
        UnitDiff(start=ua.unit.start, end=ua.unit.end, text=ua.unit.text, human=ua.a, llm=ua.b,
                 status=_HUMAN_LLM_STATUS.get(ua.status, ua.status))
        for ua in alignment.units
    ]
    return per_code, overall, diffs


def compare(
    llm_docs: List[Document], human_entries: List[HumanEntry]
) -> ComparisonResult:
    """Compara la codificación humana con la del LLM documento por documento.

    Args:
        llm_docs: documentos codificados por el LLM (con texto y fragmentos).
        human_entries: entradas humanas (cita + código) importadas.

    Returns:
        El :class:`ComparisonResult` con métricas léxicas, similitudes semánticas
        y las citas humanas que no pudieron mapearse.
    """
    unmapped: List[str] = []
    documents: List[DocumentComparison] = []

    for doc in llm_docs:
        # Asocia entradas humanas por nombre; si hay un solo documento, todas.
        humans_for_doc = [e for e in human_entries if e.document == doc.name]
        if not humans_for_doc and len(llm_docs) == 1:
            humans_for_doc = human_entries

        units = segment(doc.full_text)
        llm_spans = [
            _Span(f.start, f.end, f.code, f.quote, f.justification) for f in doc.fragments
        ]
        human_spans: List[_Span] = []
        for e in humans_for_doc:
            span = _find_span(doc.full_text, e.quotation)
            if span is None:
                unmapped.append(f"{doc.name}: {e.quotation[:60]}")
                continue
            human_spans.append(
                _Span(span[0], span[1], e.code, e.quotation, e.comment, note_field="comment")
            )

        per_code, overall, diffs = _lexical(units, llm_spans, human_spans)
        llm_frags, human_frags = _semantic(llm_spans, human_spans)

        documents.append(
            DocumentComparison(
                name=doc.name, full_text=doc.full_text, units=diffs,
                per_code=per_code, overall=overall,
                llm_fragments=llm_frags, human_fragments=human_frags,
            )
        )

    return ComparisonResult(
        documents=documents,
        embedding_model=config.EMBEDDING_MODEL,
        default_threshold=config.SEMANTIC_THRESHOLD,
        unmapped=unmapped,
    )


# --- A vs B (métricas simétricas) ---------------------------------------------
@dataclass
class SideItem:
    """Un elemento codificado de un lado: con offsets (JSON) o solo con cita (CSV)."""

    code: str
    quote: str
    note: str = ""
    note_field: str = "justification"
    start: Optional[int] = None
    end: Optional[int] = None


@dataclass
class PairDocument:
    """Un documento a comparar: su texto y los elementos de cada lado."""

    name: str
    full_text: str
    items_a: List[SideItem] = field(default_factory=list)
    items_b: List[SideItem] = field(default_factory=list)


def _observed_agreement(t: _Table) -> Optional[float]:
    """Proporción de celdas oración×código en que ambos lados coinciden."""
    n = t.both + t.only_a + t.only_b + t.neither
    return None if n == 0 else (t.both + t.neither) / n


def _positive_agreement(t: _Table) -> Optional[float]:
    """Acuerdo específico positivo: 2·ambos / (2·ambos + solo A + solo B)."""
    den = 2 * t.both + t.only_a + t.only_b
    return None if den == 0 else 2 * t.both / den


def _pair_metric(code: str, t: _Table) -> PairCodeMetric:
    return PairCodeMetric(
        code=code, both=t.both, only_a=t.only_a, only_b=t.only_b, neither=t.neither,
        kappa=_round_opt(t.kappa()),
        observed_agreement=_round_opt(_observed_agreement(t)),
        positive_agreement=_round_opt(_positive_agreement(t)),
    )


def _map_items(
    doc: PairDocument, items: List[SideItem], side_label: str, unmapped: List[str]
) -> List[_Span]:
    """Convierte los elementos de un lado en spans; reporta las citas no ubicadas."""
    spans: List[_Span] = []
    for it in items:
        if it.start is not None and it.end is not None:
            span: Optional[Tuple[int, int]] = (it.start, it.end)
        else:
            span = _find_span(doc.full_text, it.quote)
        if span is None:
            unmapped.append(f"{side_label} · {doc.name}: {it.quote[:60]}")
            continue
        spans.append(_Span(span[0], span[1], it.code, it.quote, it.note, it.note_field))
    return spans


def compare_ab(
    documents: List[PairDocument],
    a_label: str,
    b_label: str,
    missing_text: Optional[List[str]] = None,
    notes: Optional[List[str]] = None,
) -> PairComparisonResult:
    """Compara dos codificaciones cualesquiera con métricas simétricas.

    Args:
        documents: documentos con su texto y los elementos de los lados A y B.
        a_label: nombre del lado A (para los mensajes y la interfaz).
        b_label: nombre del lado B.
        missing_text: documentos omitidos por no tener texto disponible.
        notes: avisos de la preparación de las entradas.

    Returns:
        El :class:`PairComparisonResult` por documento, con métricas, diff,
        similitudes y las citas no ubicadas de cada lado.
    """
    unmapped_a: List[str] = []
    unmapped_b: List[str] = []
    results: List[PairDocumentComparison] = []

    for doc in documents:
        units = segment(doc.full_text)
        spans_a = _map_items(doc, doc.items_a, a_label, unmapped_a)
        spans_b = _map_items(doc, doc.items_b, b_label, unmapped_b)

        alignment = _align(units, spans_a, spans_b)
        total = _Table()
        per_code: List[PairCodeMetric] = []
        for code in alignment.codes:
            t = alignment.tables[code]
            per_code.append(_pair_metric(code, t))
            total.add(t)
        overall = PairOverallMetrics(
            kappa=_round_opt(total.kappa()),
            observed_agreement=_round_opt(_observed_agreement(total)),
            positive_agreement=_round_opt(_positive_agreement(total)),
        )
        diffs = [
            PairUnitDiff(start=ua.unit.start, end=ua.unit.end, text=ua.unit.text,
                         a=ua.a, b=ua.b, status=ua.status)
            for ua in alignment.units
        ]
        a_frags, b_frags = _semantic(spans_a, spans_b)
        results.append(
            PairDocumentComparison(
                name=doc.name, full_text=doc.full_text, units=diffs,
                per_code=per_code, overall=overall,
                a_fragments=a_frags, b_fragments=b_frags,
            )
        )

    return PairComparisonResult(
        documents=results,
        a_label=a_label,
        b_label=b_label,
        embedding_model=config.EMBEDDING_MODEL,
        default_threshold=config.SEMANTIC_THRESHOLD,
        unmapped_a=unmapped_a,
        unmapped_b=unmapped_b,
        missing_text=missing_text or [],
        notes=notes or [],
    )
