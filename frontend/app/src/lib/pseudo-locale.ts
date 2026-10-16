/**
 * Pseudo-localization for the DevBox i18n stresstester.
 *
 * `pseudoLocalize` transforms an English source string the way a real
 * pseudo-locale would: vowels gain accents, the string is padded with
 * expansion characters (~35% longer, matching typical German/Finnish growth),
 * and the whole string is wrapped in `⟦ ⟧` brackets so untranslated or
 * truncated strings are obvious at a glance. Placeholders like `{count}` are
 * left intact so interpolation still works.
 *
 * The module flag is process-wide and dev-only: `setPseudoLocalization` flips
 * it and notifies `I18nProvider` (via `pseudoLocaleEvent`) so every `t()` and
 * `translate()` call re-renders with transformed strings. Production bundles
 * keep the flag permanently off.
 */

export const pseudoLocaleEvent = "meltiply:pseudo-locale";

let enabled = false;

const accents: Record<string, string> = {
  a: "à",
  e: "ë",
  i: "ï",
  o: "ö",
  u: "ü",
  A: "À",
  E: "Ë",
  I: "Ï",
  O: "Ö",
  U: "Ü",
};

/**
 * Transforms a message into its pseudo-localized form. `{placeholder}` tokens
 * are preserved verbatim so `interpolate` can still substitute values.
 */
export function pseudoLocalize(message: string): string {
  const transformed = message
    .split(/(\{[^}]*\})/g)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? segment
        : segment.replace(/[aeiouAEIOU]/g, (char) => accents[char] ?? char),
    )
    .join("");
  const padding = "~".repeat(Math.max(1, Math.round(message.length * 0.35)));
  return `⟦${transformed} ${padding}⟧`;
}

/**
 * Reports whether pseudo-localization is active.
 */
export function isPseudoLocalized(): boolean {
  return enabled;
}

/**
 * Enables or disables pseudo-localization and notifies subscribers so the
 * i18n provider re-renders translated strings.
 */
export function setPseudoLocalization(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  window.dispatchEvent(new CustomEvent(pseudoLocaleEvent));
}
