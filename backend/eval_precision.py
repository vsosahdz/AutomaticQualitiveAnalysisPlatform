"""Evaluación de precisión/recall de la codificación del LLM contra un estándar de oro.

No es parte de la app: es una herramienta de medición para comparar
configuraciones (modelo, merge on/off) de forma objetiva. Anota a nivel de
ORACIÓN qué códigos aplican (referencia humana) y compara contra la salida del
pipeline mapeada también a nivel de oración.

Uso:
    OLLAMA_MODEL=qwen2.5:latest ./.venv/bin/python eval_precision.py
    OLLAMA_MODEL=qwen2.5:14b    ./.venv/bin/python eval_precision.py
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Set, Tuple

from app.models.code import Code, CodeOrigin
from app.services import coding
from app.services.segmentation import segment

# --- Estándar de oro: por documento, {índice_de_oración: {códigos}} ---
# Anotación humana de referencia con los 3 códigos base. Las oraciones no
# listadas se consideran sin código.
GOLD: Dict[str, Dict[int, Set[str]]] = {
    "entrevista_01.txt": {
        1: {"Barrera"},       # trabas burocráticas / permisos
        2: {"Barrera"},       # pérdida de conocimiento
        4: {"Estrategia"},    # crear alianzas / reorganizarse
        5: {"Estrategia"},    # sistema de comunicación por radio
        7: {"Facilitador"},   # contactos + bodega municipal ya existente
        9: {"Barrera"},       # calor extremo / erosión del suelo
    },
    "entrevista_02.txt": {
        4: {"Barrera"},       # falta de financiamiento / transporte
        5: {"Barrera"},       # acceso al agua / sequía
        7: {"Estrategia"},    # diversificar / caja de ahorro
        8: {"Estrategia"},    # negociar en bloque
        9: {"Facilitador"},   # laboratorio universitario abierto sin costo
    },
}

CODES = ["Barrera", "Facilitador", "Estrategia"]


ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = ROOT / "samples"
# Fuente única de las definiciones base: el codebook semilla del frontend.
CODEBOOK_TS = ROOT / "frontend" / "src" / "codebook.ts"


def base_definitions() -> Dict[str, str]:
    """Lee las definiciones base de ``codebook.ts`` (bloque ``BASE_DEFINITIONS``).

    Así la evaluación usa exactamente las mismas definiciones que la app y no
    pueden desincronizarse.
    """
    source = CODEBOOK_TS.read_text(encoding="utf-8")
    block = re.search(r"BASE_DEFINITIONS[^{]*\{(.*?)\n\};", source, re.S)
    if block is None:
        raise RuntimeError(f"No se encontró BASE_DEFINITIONS en {CODEBOOK_TS}")
    defs = {
        key: json.loads(f'"{value}"')
        for key, value in re.findall(r'(\w+):\s*"((?:[^"\\]|\\.)*)"', block.group(1))
    }
    missing = [c for c in CODES if c.lower() not in defs]
    if missing:
        raise RuntimeError(f"Faltan definiciones en {CODEBOOK_TS}: {missing}")
    return {c: defs[c.lower()] for c in CODES}


def codebook() -> List[Code]:
    """Codebook base con las definiciones completas que usa el frontend."""
    defs = base_definitions()
    return [
        Code(id=c.lower(), label=c, definition=defs[c], origin=CodeOrigin.base)
        for c in CODES
    ]


def predicted_by_sentence(text: str, merge: bool) -> Dict[int, Set[str]]:
    """Codifica el texto y mapea los fragmentos a códigos por índice de oración."""
    units = segment(text)
    doc, _ = coding.code_document(
        "eval.txt", text, codebook(), merge_overlaps=merge
    )
    pred: Dict[int, Set[str]] = {}
    for frag in doc.fragments:
        for u in units:
            # Una oración cuenta como cubierta si su rango cae dentro del fragmento.
            if u.start >= frag.start and u.end <= frag.end:
                pred.setdefault(u.id, set()).add(frag.code)
    return pred


def score(gold: Dict[int, Set[str]], pred: Dict[int, Set[str]]) -> Tuple[int, int, int]:
    """Cuenta (TP, FP, FN) sobre pares (oración, código)."""
    tp = fp = fn = 0
    indices = set(gold) | set(pred)
    for i in indices:
        g = gold.get(i, set())
        p = pred.get(i, set())
        tp += len(g & p)
        fp += len(p - g)
        fn += len(g - p)
    return tp, fp, fn


def prf(tp: int, fp: int, fn: int) -> Tuple[float, float, float]:
    """Calcula precisión, recall y F1 a partir de TP/FP/FN."""
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f


def run(merge: bool) -> None:
    """Evalúa todos los documentos con una configuración de merge dada."""
    model = os.getenv("OLLAMA_MODEL", "qwen2.5:latest")
    total = [0, 0, 0]
    print(f"\n### Modelo: {model} · merge={'on' if merge else 'off'}")
    for name, gold in GOLD.items():
        text = (SAMPLES_DIR / name).read_text(encoding="utf-8")
        pred = predicted_by_sentence(text, merge)
        tp, fp, fn = score(gold, pred)
        p, r, f = prf(tp, fp, fn)
        total[0] += tp
        total[1] += fp
        total[2] += fn
        print(f"  {name}: P={p:.2f} R={r:.2f} F1={f:.2f}  (TP={tp} FP={fp} FN={fn})")
    p, r, f = prf(*total)
    print(f"  TOTAL:            P={p:.2f} R={r:.2f} F1={f:.2f}")


if __name__ == "__main__":
    run(merge=True)
    run(merge=False)
