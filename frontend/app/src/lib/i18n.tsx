import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";
import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

import { isDevMode } from "@/lib/env";

import statusEn from "../locales/en/status.json";
import statusEs from "../locales/es/status.json";
import uiEs from "../locales/es/ui.json";
import { isPseudoLocalized, pseudoLocaleEvent, pseudoLocalize } from "./pseudo-locale";

export const supportedLanguages = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
] as const;

export type Language = (typeof supportedLanguages)[number]["code"];
export type TranslationValues = Record<string, number | string>;

const languageStorageKey = "meltiply.language";

// JSON imports infer their exact key union; a string index signature keeps the
// runtime lookup keyed by arbitrary English source strings.
const spanishUi: Record<string, string> = uiEs;

// Runtime catalog data lives in `src/locales/<language>/<namespace>.json` so the
// same files feed `bun run i18n:check` and generation. English source strings
// remain the runtime keys: `en/ui.json` maps every key to itself and
// `en/status.json` maps status identifiers to their English labels.
const statusTranslations: Record<Language, Record<string, string>> = {
  en: statusEn,
  es: statusEs,
};

/**
 * Substitutes named placeholder tokens (e.g. `{name}`) in a message string with provided values.
 *
 * @param message Template string containing `{token}` placeholders.
 * @param values Dictionary mapping token names to string or number substitutions.
 * @returns Interpolated string with replaced variables.
 */
function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/**
 * Translates an English UI string into the active target language with variable interpolation.
 * Falls back to the raw message when a Spanish translation entry is absent.
 * In development builds the DevBox pseudo-localization toggle additionally
 * expands every returned string (~35% growth + accents) so layout resilience
 * can be verified in place; the branch is stripped from production bundles.
 *
 * @param language Active language code ("en" or "es").
 * @param message English source message key.
 * @param values Optional substitution values for placeholders in the template.
 * @returns Translated, interpolated text.
 */
export function translate(language: Language, message: string, values?: TranslationValues): string {
  const translated = interpolate(
    language === "es" ? (spanishUi[message] ?? message) : message,
    values,
  );
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(translated) : translated;
}

/**
 * Translates an internal enum or status identifier (e.g. `awaiting_provider`) into a localized label.
 * Replaces underscores with spaces as a fallback if no explicit translation exists.
 * Subject to the same dev-only pseudo-localization expansion as `translate`.
 *
 * @param language Target language code ("en" or "es").
 * @param status Status identifier string.
 * @returns Localized status label.
 */
function translateStatus(language: Language, status: string): string {
  const label = statusTranslations[language][status] ?? status.replaceAll("_", " ");
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(label) : label;
}

/**
 * Reads the user's language preference only after functional consent, falling
 * back to `"en"` when it is absent, invalid, or unavailable.
 *
 * @returns Active `Language` code ("en" or "es").
 */
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

/**
 * Synchronizes the `lang` attribute and meta description on
 * `document.documentElement`, and persists language selection only after
 * functional consent. The current page language remains usable in memory when
 * optional storage is denied.
 *
 * @param props Component props with children.
 * @returns Context provider element.
 */
export function I18nProvider({ children }: I18nProviderProps): React.ReactElement {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  // Re-render when the DevBox pseudo-localization flag flips so every `t()`
  // and `translate()` consumer re-reads transformed strings. The tick must
  // feed the memoized context value below — a stable value identity would let
  // React bail out of consumer re-renders entirely.
  const [pseudoTick, setPseudoTick] = useState(0);

  /** Changes the in-memory language immediately and persists it only with functional consent. */
  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    writeFunctionalStorage(languageStorageKey, nextLanguage);
  }, []);

  useLayoutEffect(() => {
    // Dev-only listener: the event name is a constant, but the subscription
    // itself is stripped from production bundles with the DevBox.
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
  // Rebuilt whenever language or pseudoTick changes; pseudoTick exists so the
  // dev-only pseudo-localization toggle re-renders consumers with expanded
  // strings. The provider renders rarely, so a fresh object per render is
  // cheaper than memo bookkeeping.

  const value: I18nContextValue = {
    language,
    setLanguage,
    t: (message, values) => translate(language, message, values),
    tStatus: (status) => translateStatus(language, status),
  };
  void pseudoTick;

  return <I18nContext value={value}>{children}</I18nContext>;
}

/**
 * Accesses internationalization state and translation helpers (`t`, `tStatus`) from `I18nContext`.
 *
 * @returns `I18nContextValue` object containing language state and translation functions.
 */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
