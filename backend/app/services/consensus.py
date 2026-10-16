"""Codificación por consenso (ensamble) de varios modelos.

Ejecuta el pipeline de codificación existente con 2 o 3 modelos y consolida sus
salidas con una regla de mayoría a nivel de (oración, código): un par se conserva
si lo asigna al menos ``floor(N/2)+1`` de los modelos. Cada fragmento resultante
registra qué modelos coincidieron (metadatos de acuerdo).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Callable, Dict, FrozenSet, List, Optional, Tuple

from app.models.code import Code
from app.models.results import Document, Dropped, Fragment
from app.services import coding
from app.services.llm import get_provider
from app.services.segmentation import Unit, segment

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]


def majority_threshold(n_models: int) -> int:
    """Número mínimo de votos para conservar un par (regla de mayoría)."""
    return n_models // 2 + 1


def _units_of_fragment(units: List[Unit], frag: Fragment) -> List[int]:
    """IDs de las unidades cubiertas por completo por el span del fragmento."""
    return [u.id for u in units if u.start >= frag.start and u.end <= frag.end]


def code_document_consensus(
    name: str,
    text: str,
    codebook: List[Code],
    models: List[str],
    progress: Optional[ProgressFn] = None,
    should_cancel: Optional[CancelFn] = None,
) -> Tuple[Document, List[Dropped]]:
    """Codifica un documento por consenso de varios modelos.

    Args:
        name: nombre del archivo.
        text: transcripción cruda.
        codebook: codebook completo (se filtran los activos dentro del pipeline).
        models: 2 o 3 nombres de modelo del ensamble.
        progress: callback de progreso (fracción global 0..1 y mensaje).
        should_cancel: callback de cancelación cooperativa.

    Returns:
        ``(document, dropped)`` con fragmentos consensuados (cada uno con la lista
        de modelos coincidentes) y los descartes acumulados de todos los modelos.

    Raises:
        coding.CodingCancelled: si se solicita cancelar.
    """
    units = segment(text)
    units_by_id: Dict[int, Unit] = {u.id: u for u in units}
    n = len(models)

    # votos[(unit_id, code)] -> {modelo: justificación}
    votes: Dict[Tuple[int, str], Dict[str, str]] = defaultdict(dict)
    dropped_all: List[Dropped] = []

    # 1) Ejecuta cada modelo y acumula sus asignaciones (oración, código).
    for i, model in enumerate(models):
        if should_cancel and should_cancel():
            raise coding.CodingCancelled()

        def report(frac: float, msg: str, _i: int = i, _m: str = model) -> None:
            if progress:
                progress((_i + frac) / n, f"[{_m}] {msg}")

        provider = get_provider(model)
        doc_m, dropped_m = coding.code_document(
            name=name,
            text=text,
            codebook=codebook,
            provider=provider,
            progress=report,
            should_cancel=should_cancel,
        )
        dropped_all.extend(dropped_m)
        for frag in doc_m.fragments:
            for uid in _units_of_fragment(units, frag):
                votes[(uid, frag.code)][model] = frag.justification

    # 2) Conserva los pares con mayoría.
    threshold = majority_threshold(n)
    kept = {key: mj for key, mj in votes.items() if len(mj) >= threshold}

    # 3) Reconstruye fragmentos: agrupa oraciones consecutivas con el mismo código
    #    Y el mismo conjunto de modelos coincidentes.
    by_code: Dict[str, List[int]] = defaultdict(list)
    for (uid, code) in kept:
        by_code[code].append(uid)

    fragments: List[Fragment] = []
    for code, uids in by_code.items():
        uids.sort()
        run: List[int] = []
        run_voters: Optional[FrozenSet[str]] = None
        prev_uid: Optional[int] = None

        def flush() -> None:
            if not run or run_voters is None:
                return
            start = units_by_id[run[0]].start
            end = units_by_id[run[-1]].end
            # Justificaciones únicas de los modelos coincidentes en el tramo.
            justs: List[str] = []
            for uid in run:
                for m in sorted(run_voters):
                    j = kept[(uid, code)].get(m, "").strip()
                    if j and j not in justs:
                        justs.append(j)
            fragments.append(
                Fragment(
                    start=start,
                    end=end,
                    code=code,
                    quote=text[start:end],
                    justification=" | ".join(justs),
                    models=sorted(run_voters),
                )
            )

        for uid in uids:
            voters = frozenset(kept[(uid, code)].keys())
            if run and prev_uid is not None and uid == prev_uid + 1 and voters == run_voters:
                run.append(uid)
            else:
                flush()
                run = [uid]
                run_voters = voters
            prev_uid = uid
        flush()

    fragments.sort(key=lambda f: (f.start, f.end, f.code))
    if progress:
        progress(1.0, f"{name}: consenso completado")

    return Document(name=name, full_text=text, fragments=fragments), dropped_all
