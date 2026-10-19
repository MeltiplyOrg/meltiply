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

// JSON imports infer their exact key union; string index signatures keep the
// runtime lookup keyed by arbitrary English source strings.
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

// Runtime catalog data lives in `src/locales/<language>/<namespace>.json` so the
// same files feed `bun run i18n:check` and generation. English source strings
// remain the runtime keys: `en/ui.json` maps every key to itself and
// `en/status.json` maps status identifiers to their English labels.
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

/** Resolves a message's text in the active language, before any substitution. */
function lookupMessage(language: Language, message: string): string {
  return uiTranslations[language][message] ?? message;
}

/**
 * Substitutes named placeholder tokens (e.g. `{count}`) in a translated message
 * with nodes, so a sentence can hold a component — a count that rolls, for
 * instance — without the surrounding copy being assembled from fragments.
 *
 * Literal text keeps the same dev-only pseudo-localization as `translate`; the
 * inserted nodes are left alone, because their own content is the shipped surface.
 * A token with no value keeps its placeholder text, exactly as `interpolate` does.
 *
 * @param language Active language code.
 * @param message English source message key.
 * @param values Nodes keyed by the placeholder tokens they replace.
 * @returns The message as nodes, ready to render inside a sentence.
 */
function translateNodes(
  language: Language,
  message: string,
  values: Record<string, ReactNode>,
): ReactNode {
  const parts: ReactNode[] = [];
  const template = lookupMessage(language, message);
  let cursor = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
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

/**
 * Translates an English UI string into the active target language with variable interpolation.
 * Falls back to the raw message when a target translation entry is absent.
 * In development builds the DevBox pseudo-localization toggle additionally
 * expands every returned string (~35% growth + accents) so layout resilience
 * can be verified in place; the branch is stripped from production bundles.
 *
 * @param language Active language code.
 * @param message English source message key.
 * @param values Optional substitution values for placeholders in the template.
 * @returns Translated, interpolated text.
 */
export function translate(language: Language, message: string, values?: TranslationValues): string {
  const translated = interpolate(lookupMessage(language, message), values);
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(translated) : translated;
}

/**
 * Translates an internal enum or status identifier (e.g. `awaiting_provider`) into a localized label.
 * Replaces underscores with spaces as a fallback if no explicit translation exists.
 * Subject to the same dev-only pseudo-localization expansion as `translate`.
 *
 * @param language Target language code.
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
 * @returns Active `Language` code, or `"en"` when no supported value is stored.
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
  // strings. Memoizing keeps that key complete while a provider re-render for
  // any other reason - consent, an unmounting sibling, a dev toggle - from
  // handing every `t()`/`translate()` consumer a new context identity.
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

/**
 * Accesses internationalization state and translation helpers (`t`, `tStatus`) from `I18nContext`.
 *
 * @returns `I18nContextValue` object containing language state and translation functions.
 */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/**
 * A translated message whose placeholders carry components, so a sentence can hold
 * a surface — a count that rolls, for instance — instead of being assembled from
 * translated fragments. Reads the active language from `I18nContext` and renders
 * `translateNodes`, so a message resolves exactly as `t` resolves it.
 *
 * @param props.message - English source message key containing `{token}` placeholders.
 * @param props.values - Nodes keyed by the placeholder tokens they replace.
 * @returns The translated sentence, ready to render where the copy belongs.
 */
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
