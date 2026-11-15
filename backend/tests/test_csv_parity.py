"""El caso fijo de paridad del CSV coincide con lo que genera el backend.

El frontend (frontend/src/csvExport.test.ts) exige producir exactamente estos
CSV; si cambian las reglas del backend, esta prueba obliga a regenerar el caso.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.models.results import Result
from app.services import csv_export

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "fixtures" / "csvParity.json"


def test_fixture_matches_backend_csv():
    for case in json.loads(FIXTURE.read_text(encoding="utf-8")):
        result = Result(**case["result"])
        assert csv_export.result_to_csv(result) == case["combined"], case["name"]
        total = len(result.models) if result.analysis_type == "consensus" else 0
        with_origin = csv_export.has_edits(result.documents)
        for doc in result.documents:
            expected = case["per_document"][doc.name]
            assert csv_export.document_to_csv(doc, total, with_origin) == expected, case["name"]
