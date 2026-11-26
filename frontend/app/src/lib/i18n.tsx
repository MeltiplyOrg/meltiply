import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

import { isDevMode } from "@/lib/env";

import statusDe from "../locales/de/status.json";
import statusEn from "../locales/en/status.json";
import statusEs from "../locales/es/status.json";
import statusFr from "../locales/fr/status.json";
import statusIt from "../locales/it/status.json";
import statusPtBR from "../locales/pt-BR/status.json";
import statusVi from "../locales/vi/status.json";
import statusZh from "../locales/zh/status.json";
import uiDe from "../locales/de/ui.json";
import uiEs from "../locales/es/ui.json";
import uiFr from "../locales/fr/ui.json";
import uiIt from "../locales/it/ui.json";
import uiPtBR from "../locales/pt-BR/ui.json";
import uiVi from "../locales/vi/ui.json";
import uiZh from "../locales/zh/ui.json";
import { isPseudoLocalized, pseudoLocaleEvent, pseudoLocalize } from "./pseudo-locale";

const placeholderPattern = /\{(\w+)\}/g;

export const supportedLanguages = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "zh", label: "简体中文" },
  { code: "vi", label: "Tiếng Việt" },
] as const;

export type Language = (typeof supportedLanguages)[number]["code"];
export type TranslationValues = Record<string, number | string>;

const languageStorageKey = "meltiply.language";

const uiTranslations: Record<Language, Record<string, string>> = {
  en: {},
  es: uiEs,
  "pt-BR": uiPtBR,
  fr: uiFr,
  de: uiDe,
  it: uiIt,
  zh: uiZh,
  vi: uiVi,
};

const statusTranslations: Record<Language, Record<string, string>> = {
  en: statusEn,
  es: statusEs,
  "pt-BR": statusPtBR,
  fr: statusFr,
  de: statusDe,
  it: statusIt,
  zh: statusZh,
  vi: statusVi,
};

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(placeholderPattern, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

function lookupMessage(language: Language, message: string): string {
  return uiTranslations[language][message] ?? message;
}

function translateNodes(
  language: Language,
  message: string,
  values: Record<string, ReactNode>,
): ReactNode {
  const parts: ReactNode[] = [];
  const template = lookupMessage(language, message);
  let cursor = 0;
  for (const match of template.matchAll(placeholderPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(template.slice(cursor, start));
    parts.push(
      <Fragment key={`${match[1]}-${start}`}>
        {Object.hasOwn(values, match[1]) ? values[match[1]] : match[0]}
      </Fragment>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < template.length) parts.push(template.slice(cursor));

  if (!isDevMode() || !isPseudoLocalized()) return parts;
  return parts.map((part) => (typeof part === "string" ? pseudoLocalize(part) : part));
}

export function translate(language: Language, message: string, values?: TranslationValues): string {
  const translated = interpolate(lookupMessage(language, message), values);
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(translated) : translated;
}

function translateStatus(language: Language, status: string): string {
  const label = statusTranslations[language][status] ?? status.replaceAll("_", " ");
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(label) : label;
}

function readStoredLanguage(): Language {
  const stored = readFunctionalStorage(languageStorageKey);
  return supportedLanguages.some(({ code }) => code === stored) ? (stored as Language) : "en";
}

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (message: string, values?: TranslationValues) => string;
  tStatus: (status: string) => string;
};

const defaultValue: I18nContextValue = {
  language: "en",
  setLanguage: () => undefined,
  t: (message, values) => translate("en", message, values),
  tStatus: (status) => translateStatus("en", status),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

type I18nProviderProps = {
  children: React.ReactNode;
};

export function I18nProvider({ children }: I18nProviderProps): React.ReactElement {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  const [pseudoTick, setPseudoTick] = useState(0);

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    writeFunctionalStorage(languageStorageKey, nextLanguage);
  }, []);

  useLayoutEffect(() => {
    if (!isDevMode()) return;
    const onPseudoToggle = () => setPseudoTick((tick) => tick + 1);
    window.addEventListener(pseudoLocaleEvent, onPseudoToggle);
    return () => window.removeEventListener(pseudoLocaleEvent, onPseudoToggle);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) {
      description.content = translate(
        language,
        "Prepare assets, schedule distribution, monitor provider state, and respond to your audience from one dependable workspace.",
      );
    }
  }, [language]);
  const value = useMemo<I18nContextValue>(() => {
    void pseudoTick;
    return {
      language,
      setLanguage,
      t: (message, values) => translate(language, message, values),
      tStatus: (status) => translateStatus(language, status),
    };
  }, [language, setLanguage, pseudoTick]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function Trans({
  message,
  values,
}: {
  message: string;
  values: Record<string, ReactNode>;
}): React.ReactElement {
  const { language } = useI18n();
  return <>{translateNodes(language, message, values)}</>;
}
