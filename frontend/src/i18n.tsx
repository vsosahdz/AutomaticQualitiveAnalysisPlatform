// Idioma de la interfaz (español / inglés).
//
// Los textos viven en locales/es.ts y locales/en.ts. Los componentes usan
// useI18n() para volver a renderizarse al cambiar de idioma; los módulos sin
// React (validaciones, edición) usan t(), que lee el idioma vigente en el
// momento de la llamada. Los datos (etiquetas del codebook, definiciones que van
// al prompt, columnas de los archivos exportados) no se traducen.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { es, type MessageKey } from "./locales/es";
import { en } from "./locales/en";

export type Lang = "es" | "en";
export type { MessageKey };
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<MessageKey, string>> = { es, en };
const STORAGE_KEY = "aqa-lang";

function storedLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "es" || v === "en") return v;
  } catch {
    // Sin acceso a localStorage: se usa el idioma por defecto.
  }
  return "es";
}

let current: Lang = storedLang();

/** Traduce una clave al idioma indicado, sustituyendo los {parámetros}. */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const text = DICTS[lang][key] ?? es[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Traduce al idioma vigente (para código fuera de componentes). */
export function t(key: MessageKey, params?: Params): string {
  return translate(current, key, params);
}

/**
 * Traduce los mensajes de progreso que envía el backend (en español).
 * Formatos: "<doc>: ventana i/n", "<doc>: completado", "<doc>: consenso completado",
 * "[modelo] …" y los estados "Completado", "Error" y "Cancelado".
 */
export function localizeProgress(message: string, lang: Lang): string {
  if (lang === "es" || !message) return message;
  return message
    .replace(/ventana (\d+)\/(\d+)/g, "window $1/$2")
    .replace(/consenso completado/g, "consensus complete")
    .replace(/completado/gi, "complete")
    .replace(/^Cancelado$/, "Cancelled");
}

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, params?: Params) => string;
}

const I18nContext = createContext<I18nValue>({
  lang: current,
  setLang: () => undefined,
  t,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);

  const setLang = useCallback((next: Lang) => {
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignorado: el idioma solo no se recordará.
    }
    setLangState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = translate(lang, "app.title");
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Idioma vigente, su selector y la función de traducción. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
