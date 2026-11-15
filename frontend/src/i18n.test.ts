import { describe, expect, it } from "vitest";
import { localizeProgress, translate } from "./i18n";
import { es } from "./locales/es";
import { en } from "./locales/en";

describe("i18n", () => {
  it("both languages define the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it("every placeholder in Spanish also exists in English", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(es) as Array<keyof typeof es>) {
      expect(vars(en[key]), key).toEqual(vars(es[key]));
    }
  });

  it("substitutes parameters", () => {
    expect(translate("es", "run.ensemble", { n: 2 })).toBe("Modelos del ensamble (2/3):");
    expect(translate("en", "pair.only", { label: "Ana" })).toBe("Ana only");
  });

  it("localizes backend progress messages", () => {
    expect(localizeProgress("e1.txt: ventana 2/5", "en")).toBe("e1.txt: window 2/5");
    expect(localizeProgress("[qwen] e1.txt: completado", "en")).toBe("[qwen] e1.txt: complete");
    expect(localizeProgress("e1.txt: consenso completado", "en")).toBe("e1.txt: consensus complete");
    expect(localizeProgress("e1.txt: ventana 2/5", "es")).toBe("e1.txt: ventana 2/5");
  });
});
