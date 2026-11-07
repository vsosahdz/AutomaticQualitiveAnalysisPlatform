"""Pipeline de codificación de un documento (Estrategia C, extremo a extremo).

Orquesta: segmentar → agrupar en ventanas con IDs globales → codificar cada
ventana con el proveedor de LLM → validar la salida (IDs y códigos) → resolver
IDs a offsets exactos → construir fragmentos, uniendo resultados de todas las
ventanas sin duplicados.

El pipeline no conoce el LLM concreto: usa la abstracción ``LLMProvider`` que le
inyecta la fábrica, de modo que Ollama sea intercambiable por un LLM en la nube.
"""
from __future__ import annotations

from typing import Callable, Dict, List, Optional, Set, Tuple

from app.core import config
from app.models.code import Code
from app.models.results import Document, Dropped, Fragment
from app.services.llm import LLMProvider, RawCoding, get_provider
from app.services.segmentation import Unit, segment

# Tipo del callback de progreso: recibe una fracción 0..1 y un mensaje.
ProgressFn = Callable[[float, str], None]
# Tipo del callback de cancelación: devuelve True si hay que abortar.
CancelFn = Callable[[], bool]


class CodingCancelled(Exception):
    """Se lanza cuando la codificación se aborta por solicitud de cancelación."""


def _make_windows(units: List[Unit]) -> List[List[Unit]]:
    """Agrupa las unidades en ventanas que no exceden ``WINDOW_CHARS``.

    Las ventanas SOLAPAN ``WINDOW_OVERLAP`` caracteres para no partir ideas en la
    frontera. Como cada unidad conserva su ID global, unir resultados es trivial.

    Args:
        units: unidades del documento (con IDs globales).

    Returns:
        Lista de ventanas; cada ventana es una lista de unidades.
    """
    if not units:
        return []

    windows: List[List[Unit]] = []
    current: List[Unit] = []
    current_chars = 0

    for unit in units:
        unit_len = unit.end - unit.start
        # Si añadir esta unidad excede el tamaño y ya hay contenido, cierra ventana.
        if current and current_chars + unit_len > config.WINDOW_CHARS:
            windows.append(current)
            # Inicia la nueva ventana con solape: reutiliza las últimas unidades
            # de la ventana previa hasta cubrir WINDOW_OVERLAP caracteres.
            overlap: List[Unit] = []
            overlap_chars = 0
            for prev in reversed(current):
                plen = prev.end - prev.start
                if overlap_chars + plen > config.WINDOW_OVERLAP:
                    break
                overlap.insert(0, prev)
                overlap_chars += plen
            current = list(overlap)
            current_chars = overlap_chars
        current.append(unit)
        current_chars += unit_len

    if current:
        windows.append(current)
    return windows


def _validate_and_collect(
    raw_codings: List[RawCoding],
    units_by_id: Dict[int, Unit],
    active_labels: Set[str],
    doc_name: str,
    seen: Set[Tuple[int, int, str]],
    fragments: List[Fragment],
    dropped: List[Dropped],
    full_text: str,
) -> None:
    """Valida codificaciones crudas de una ventana y acumula fragmentos válidos.

    Descarta (y registra en ``dropped``):
    - IDs de unidad inexistentes o fuera de rango,
    - códigos que no pertenecen al conjunto activo enviado.
    Deduplica por (start, end, code) usando ``seen`` para que el solape entre
    ventanas no genere fragmentos repetidos.

    Los resultados se acumulan por efecto lateral en ``fragments``/``dropped``.
    """
    # Índice etiqueta normalizada -> etiqueta canónica, para casar sin
    # sensibilidad a mayúsculas/espacios y devolver la etiqueta oficial.
    canonical = {label.strip().lower(): label for label in active_labels}

    for rc in raw_codings:
        # 1) Valida el código contra el conjunto activo.
        code_key = rc.code.strip().lower()
        if code_key not in canonical:
            dropped.append(
                Dropped(
                    document=doc_name,
                    reason=f"Código no presente en el codebook: '{rc.code}'",
                    raw=f"U{rc.unit_start}..U{rc.unit_end} -> {rc.code}",
                )
            )
            continue

        # 2) Valida los IDs de unidad del rango.
        start_unit = units_by_id.get(rc.unit_start)
        end_unit = units_by_id.get(rc.unit_end)
        if start_unit is None or end_unit is None:
            dropped.append(
                Dropped(
                    document=doc_name,
                    reason=f"ID de unidad fuera de rango: U{rc.unit_start}..U{rc.unit_end}",
                    raw=str(rc),
                )
            )
            continue

        # 3) Resuelve el rango de IDs a offsets exactos (inicio de la primera
        #    unidad al fin de la última).
        start_off = start_unit.start
        end_off = end_unit.end
        label = canonical[code_key]

        key = (start_off, end_off, label)
        if key in seen:
            continue  # ya visto en otra ventana (solape): no duplicar
        seen.add(key)

        fragments.append(
            Fragment(
                start=start_off,
                end=end_off,
                code=label,
                quote=full_text[start_off:end_off],
                justification=rc.justification,
            )
        )


def _merge_same_code_overlaps(
    fragments: List[Fragment], full_text: str
) -> List[Fragment]:
    """Fusiona en su unión los fragmentos del MISMO código que se solapan o anidan.

    Es una red de seguridad contra rangos redundantes (un tramo amplio más un
    sub-rango anidado con la misma etiqueta) que el LLM a veces emite. Los
    fragmentos de códigos DISTINTOS nunca se fusionan: el solape entre códigos es
    un empalme legítimo que el visor muestra aparte.

    Args:
        fragments: fragmentos ya construidos (con offsets y código).
        full_text: texto original, para recomputar la cita de la unión.

    Returns:
        Nueva lista de fragmentos sin solapes dentro de un mismo código.
    """
    # Agrupa por código.
    by_code: Dict[str, List[Fragment]] = {}
    for f in fragments:
        by_code.setdefault(f.code, []).append(f)

    merged: List[Fragment] = []
    for code, group in by_code.items():
        # Ordena por inicio y fusiona los que se tocan/solapan.
        group.sort(key=lambda f: (f.start, f.end))
        cur = group[0]
        # Justificación candidata: la más larga vista en el grupo fusionado.
        cur_just = cur.justification
        for nxt in group[1:]:
            if nxt.start <= cur.end:  # se solapan o se anidan → unión
                new_end = max(cur.end, nxt.end)
                if len(nxt.justification) > len(cur_just):
                    cur_just = nxt.justification
                cur = Fragment(
                    start=cur.start,
                    end=new_end,
                    code=code,
                    quote=full_text[cur.start:new_end],
                    justification=cur_just,
                )
            else:
                merged.append(cur)
                cur = nxt
                cur_just = nxt.justification
        merged.append(cur)
    return merged


def code_document(
    name: str,
    text: str,
    codebook: List[Code],
    provider: Optional[LLMProvider] = None,
    progress: Optional[ProgressFn] = None,
    should_cancel: Optional[CancelFn] = None,
    merge_overlaps: bool = True,
) -> Tuple[Document, List[Dropped]]:
    """Codifica un documento completo y devuelve su :class:`Document` y descartes.

    Args:
        name: nombre del archivo.
        text: texto crudo de la transcripción.
        codebook: codebook completo (se filtran los códigos activos).
        provider: proveedor de LLM a usar; si es ``None`` se obtiene de la fábrica.
        progress: callback opcional para reportar avance por ventana.
        should_cancel: callback opcional; si devuelve True antes de procesar una
            ventana, se aborta lanzando :class:`CodingCancelled`.

    Returns:
        Una tupla ``(document, dropped)`` donde ``document`` incluye los
        fragmentos ordenados por posición y ``dropped`` las salidas descartadas.

    Raises:
        CodingCancelled: si ``should_cancel`` solicita abortar.
    """
    llm = provider or get_provider()

    active = [c for c in codebook if c.active]
    active_labels = {c.label for c in active}

    units = segment(text)
    units_by_id = {u.id: u for u in units}
    windows = _make_windows(units)

    fragments: List[Fragment] = []
    dropped: List[Dropped] = []
    seen: Set[Tuple[int, int, str]] = set()

    total = max(len(windows), 1)
    for i, window in enumerate(windows):
        # Punto de cancelación cooperativo: se revisa antes de cada llamada al LLM
        # (que es la operación cara).
        if should_cancel and should_cancel():
            raise CodingCancelled()
        if progress:
            progress(i / total, f"{name}: ventana {i + 1}/{total}")
        raw = llm.code_units(window, active)
        _validate_and_collect(
            raw_codings=raw,
            units_by_id=units_by_id,
            active_labels=active_labels,
            doc_name=name,
            seen=seen,
            fragments=fragments,
            dropped=dropped,
            full_text=text,
        )

    # Red de seguridad: fusiona solapes/anidamientos del mismo código.
    if merge_overlaps:
        fragments = _merge_same_code_overlaps(fragments, text)
    # Ordena los fragmentos por posición para un visor/CSV consistentes.
    fragments.sort(key=lambda f: (f.start, f.end, f.code))
    if progress:
        progress(1.0, f"{name}: completado")

    return Document(name=name, full_text=text, fragments=fragments), dropped
