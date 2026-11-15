import { describe, expect, it } from "vitest";
import type { CodedDocument, Fragment } from "./types";
import {
  addFragment,
  editFragment,
  isEdited,
  removeFragment,
  trimRange,
  validateRange,
} from "./editing";

const TEXT = "Las trabas nos frenaron. Creamos alianzas con la comunidad.";
// "Las trabas nos frenaron." = [0, 24) · "Creamos" = [25, 32) · "Creamos alianzas" = [25, 41)

function frag(start: number, end: number, code: string, extra: Partial<Fragment> = {}): Fragment {
  return {
    start,
    end,
    code,
    quote: TEXT.slice(start, end),
    justification: "j",
    origin: "llm",
    ...extra,
  };
}

function docWith(...fragments: Fragment[]): CodedDocument {
  return { name: "e.txt", full_text: TEXT, fragments, removed_fragments: [] };
}

describe("trimRange", () => {
  it("recorta espacios de los extremos", () => {
    // [24, 33) = " Creamos " → "Creamos" [25, 32)
    expect(trimRange(TEXT, 24, 33)).toEqual({ start: 25, end: 32 });
  });
  it("devuelve null si solo hay espacios", () => {
    expect(trimRange("a   b", 1, 4)).toBeNull();
  });
  it("acepta extremos invertidos", () => {
    expect(trimRange(TEXT, 10, 4)).toEqual({ start: 4, end: 10 });
  });
});

describe("addFragment", () => {
  it("crea un hallazgo manual con la cita exacta", () => {
    const res = addFragment(docWith(), 24, 41, "Estrategia", "  nota ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fragment).toMatchObject({
      start: 25,
      end: 41,
      code: "Estrategia",
      quote: "Creamos alianzas",
      justification: "nota",
      origin: "manual",
    });
  });

  it("rechaza un solape con la misma etiqueta", () => {
    const res = addFragment(docWith(frag(0, 24, "Barrera")), 4, 10, "Barrera");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("Barrera");
  });

  it("permite un solape con otra etiqueta", () => {
    const res = addFragment(docWith(frag(0, 24, "Barrera")), 4, 10, "Estrategia");
    expect(res.ok).toBe(true);
  });

  it("mantiene los fragmentos ordenados por posición", () => {
    const res = addFragment(docWith(frag(25, 41, "Estrategia")), 0, 24, "Barrera");
    expect(res.ok && res.doc.fragments.map((f) => f.start)).toEqual([0, 25]);
  });
});

describe("editFragment", () => {
  it("un fragmento llm pasa a editado y guarda sus valores originales", () => {
    const original = frag(0, 24, "Barrera");
    const res = editFragment(docWith(original), original, { start: 4, end: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fragment).toMatchObject({
      start: 4,
      end: 10,
      quote: "trabas",
      code: "Barrera",
      justification: "j",
      origin: "editado",
      original: { start: 0, end: 24, code: "Barrera", justification: "j" },
    });
  });

  it("un fragmento editado conserva los valores del análisis al volver a editarse", () => {
    const original = frag(0, 24, "Barrera");
    const first = editFragment(docWith(original), original, { code: "Facilitador" });
    if (!first.ok || !first.fragment) throw new Error("primera edición falló");
    const second = editFragment(first.doc, first.fragment, { justification: "otra" });
    expect(second.ok && second.fragment?.original).toEqual({
      start: 0,
      end: 24,
      code: "Barrera",
      justification: "j",
    });
  });

  it("un fragmento manual sigue siendo manual", () => {
    const manual = frag(0, 24, "Barrera", { origin: "manual" });
    const res = editFragment(docWith(manual), manual, { code: "Estrategia" });
    expect(res.ok && res.fragment?.origin).toBe("manual");
  });

  it("sin cambios reales no altera el documento", () => {
    const f = frag(0, 24, "Barrera");
    const doc = docWith(f);
    const res = editFragment(doc, f, { justification: "j" });
    expect(res.ok && res.doc).toBe(doc);
  });

  it("rechaza cambiar a una etiqueta que choca con otro fragmento", () => {
    const a = frag(0, 24, "Barrera");
    const b = frag(4, 10, "Estrategia");
    const res = editFragment(docWith(a, b), b, { code: "Barrera" });
    expect(res.ok).toBe(false);
  });

  it("no choca consigo mismo al ajustar la extensión", () => {
    const a = frag(0, 24, "Barrera");
    const res = editFragment(docWith(a), a, { start: 0, end: 10 });
    expect(res.ok).toBe(true);
  });
});

describe("removeFragment", () => {
  it("conserva aparte los fragmentos del análisis eliminados", () => {
    const f = frag(0, 24, "Barrera");
    const res = removeFragment(docWith(f), f);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.fragments).toEqual([]);
    expect(res.doc.removed_fragments).toEqual([f]);
    expect(isEdited(res.doc)).toBe(true);
  });

  it("descarta los fragmentos manuales eliminados", () => {
    const f = frag(0, 24, "Barrera", { origin: "manual" });
    const res = removeFragment(docWith(f), f);
    expect(res.ok && res.doc.removed_fragments).toEqual([]);
  });
});

describe("validateRange", () => {
  it("rechaza tramos fuera del texto", () => {
    expect(validateRange(docWith(), 0, TEXT.length + 1, "Barrera")).not.toBeNull();
  });
  it("trata fragmentos sin origen (JSON antiguo) como no editados", () => {
    const old: Fragment = { start: 0, end: 24, code: "Barrera", quote: TEXT.slice(0, 24), justification: "" };
    expect(isEdited(docWith(old))).toBe(false);
  });
});
