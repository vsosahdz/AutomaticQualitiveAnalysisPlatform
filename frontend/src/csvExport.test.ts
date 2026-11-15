// Paridad con el CSV del backend: el caso fijo lo genera
// backend/app/services/csv_export.py y lo verifica backend/tests/test_csv_parity.py.
import { describe, expect, it } from "vitest";
import cases from "./fixtures/csvParity.json";
import { csvOptions, documentsToCsv } from "./csvExport";
import { normalizeDocument } from "./aqaFile";
import type { CodedDocument, Result } from "./types";

describe("paridad del CSV con el backend", () => {
  for (const c of cases) {
    const result = c.result as unknown as Result;
    const docs = (result.documents as CodedDocument[]).map(normalizeDocument);
    const options = csvOptions(result, docs);

    it(`CSV combinado: ${c.name}`, () => {
      expect(documentsToCsv(docs, options)).toBe(c.combined);
    });

    it(`CSV por documento: ${c.name}`, () => {
      for (const d of docs) {
        expect(documentsToCsv([d], options)).toBe(
          (c.per_document as Record<string, string>)[d.name]
        );
      }
    });
  }
});
