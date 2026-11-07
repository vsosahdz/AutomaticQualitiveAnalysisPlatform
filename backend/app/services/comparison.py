"""Comparación humano vs LLM: capa léxica (acuerdo) y semántica (similitud).

Alinea dos codificaciones del mismo documento a nivel de (oración, código) para
las métricas léxicas (P/R/F1, Cohen's kappa) y usa embeddings de las citas para
la capa semántica, que permite reconocer el mismo hallazgo aunque el texto
difiera y detectar hallazgos solo-IA por novedad.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Set, Tuple

from app.core import config
from app.models.comparison import (
    CodeMetric,
    ComparisonResult,
    DocumentComparison,
    FragmentSim,
    OverallMetrics,
    UnitDiff,
)
from app.models.results import Document
from app.services import embeddings
from app.services.human_import import HumanEntry
from app.services.segmentation import Unit, segment

# --- Fragmento humano ya mapeado a offsets del texto -----------------------
class _Span:
    """Un fragmento con offsets, código y texto (LLM o humano)."""

    def __init__(self, start: int, end: int, code: str, quote: str, extra: str = ""):
        self.start = start
        self.end = end
        self.code = code
        self.quote = quote
        self.extra = extra  # justificación (LLM) o comentario (humano)


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

    Se usa solape (no contención) para que tanto los spans del LLM —que abarcan
    oraciones completas— como las citas humanas —que suelen ser sub-oración—
    queden asociados a la(s) oración(es) correspondiente(s).
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


def _lexical(
    units: List[Unit], llm: List[_Span], human: List[_Span]
) -> Tuple[List[CodeMetric], OverallMetrics, List[UnitDiff]]:
    """Calcula métricas léxicas y el diff por oración a nivel (oración, código)."""
    # Mapea cada lado a códigos por unidad.
    llm_by_unit: Dict[int, Set[str]] = {u.id: set() for u in units}
    human_by_unit: Dict[int, Set[str]] = {u.id: set() for u in units}
    for s in llm:
        for uid in _units_covered(units, s.start, s.end):
            llm_by_unit[uid].add(s.code)
    for s in human:
        for uid in _units_covered(units, s.start, s.end):
            human_by_unit[uid].add(s.code)

    codes = sorted({s.code for s in llm} | {s.code for s in human})

    per_code: List[CodeMetric] = []
    tot_tp = tot_fp = tot_fn = 0
    # Acumuladores para kappa global (sobre todas las celdas oración×código).
    gA = gB = gC = gD = 0
    for code in codes:
        tp = fp = fn = 0
        a = b = c = d = 0  # tabla 2x2 para kappa del código
        for u in units:
            h = code in human_by_unit[u.id]
            l = code in llm_by_unit[u.id]
            if h and l:
                tp += 1; a += 1
            elif l and not h:
                fp += 1; c += 1
            elif h and not l:
                fn += 1; b += 1
            else:
                d += 1
        p, r, f = _prf(tp, fp, fn)
        per_code.append(
            CodeMetric(code=code, tp=tp, fp=fp, fn=fn, precision=round(p, 3),
                       recall=round(r, 3), f1=round(f, 3), kappa=_round_opt(_kappa(a, b, c, d)))
        )
        tot_tp += tp; tot_fp += fp; tot_fn += fn
        gA += a; gB += b; gC += c; gD += d

    p, r, f = _prf(tot_tp, tot_fp, tot_fn)
    overall = OverallMetrics(precision=round(p, 3), recall=round(r, 3),
                             f1=round(f, 3), kappa=_round_opt(_kappa(gA, gB, gC, gD)))

    # Diff por oración.
    diffs: List[UnitDiff] = []
    for u in units:
        h = sorted(human_by_unit[u.id])
        l = sorted(llm_by_unit[u.id])
        if not h and not l:
            status = "none"
        elif set(h) == set(l):
            status = "agree"
        elif h and not l:
            status = "only_human"
        elif l and not h:
            status = "only_llm"
        else:
            status = "partial"
        diffs.append(UnitDiff(start=u.start, end=u.end, text=u.text, human=h, llm=l, status=status))
    return per_code, overall, diffs


def _round_opt(x: Optional[float]) -> Optional[float]:
    """Redondea un valor opcional a 3 decimales."""
    return None if x is None else round(x, 3)


def _semantic(
    llm: List[_Span], human: List[_Span]
) -> Tuple[List[FragmentSim], List[FragmentSim]]:
    """Calcula, por fragmento, la máxima similitud del coseno con el otro lado.

    Embebe todas las citas de una sola vez y devuelve los fragmentos del LLM y los
    humanos con su similitud máxima al lado contrario.
    """
    llm_texts = [s.quote for s in llm]
    human_texts = [s.quote for s in human]
    vecs = embeddings.embed_texts(llm_texts + human_texts)
    llm_vecs = vecs[: len(llm)]
    human_vecs = vecs[len(llm):]

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

    llm_frags: List[FragmentSim] = []
    for i, s in enumerate(llm):
        sim, q, c = best(llm_vecs[i], human, human_vecs)
        llm_frags.append(FragmentSim(
            code=s.code, quote=s.quote, start=s.start, end=s.end, justification=s.extra,
            max_similarity=round(sim, 3), best_match_quote=q, best_match_code=c))

    human_frags: List[FragmentSim] = []
    for i, s in enumerate(human):
        sim, q, c = best(human_vecs[i], llm, llm_vecs)
        human_frags.append(FragmentSim(
            code=s.code, quote=s.quote, start=s.start, end=s.end, comment=s.extra,
            max_similarity=round(sim, 3), best_match_quote=q, best_match_code=c))

    return llm_frags, human_frags


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
            human_spans.append(_Span(span[0], span[1], e.code, e.quotation, e.comment))

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
