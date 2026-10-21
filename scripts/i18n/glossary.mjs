import { readFileSync } from "node:fs";

const SUPPORTED_VERSION = 1;

/**
 * Raised when the shared glossary is missing required sections or contains an
 * entry the check wrapper cannot pass to Shipi18n safely.
 */
export class GlossaryError extends Error {
  /**
   * @param {string} message Actionable validation failure.
   */
  constructor(message) {
    super(message);
    this.name = "GlossaryError";
  }
}

/**
 * Requires a non-empty string, used for prose notes, styles, and translations.
 *
 * @param {unknown} value Candidate value.
 * @param {string} description Field description for the error.
 * @throws {GlossaryError} When the value is not a non-empty string.
 */
function assertNonEmptyString(value, description) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GlossaryError(`${description} must be a non-empty string`);
  }
}

/**
 * Requires a non-empty string that can be passed through Shipi18n's
 * comma-separated `--ignore-keys` list.
 *
 * @param {unknown} value Candidate term.
 * @param {string} description Field description for the error.
 * @throws {GlossaryError} When the term is empty or contains a comma.
 */
function assertTerm(value, description) {
  assertNonEmptyString(value, description);
  if (value.includes(",")) {
    throw new GlossaryError(`${description} must not contain a comma: ${JSON.stringify(value)}`);
  }
}

/**
 * Requires a plain object (not null or an array).
 *
 * @param {unknown} value Candidate value.
 * @param {string} description Field description for the error.
 * @throws {GlossaryError} When the value is not an object.
 */
function assertRecord(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GlossaryError(`${description} must be an object`);
  }
}

/**
 * Reads and validates the glossary shared by generation, the Shipi18n check,
 * and the catalog test. Rejects commas in every term because Shipi18n splits
 * `--ignore-keys` on commas; rejecting once here is clearer than silently
 * dropping half of a pattern.
 *
 * @param {string} path Absolute or repository-relative glossary JSON path.
 * @returns {{version: number, style: Record<string, string>, keepVerbatim: Record<string, string>, preferredTranslations: Record<string, Record<string, string>>, intentionallyIdentical: string[]}}
 * @throws {GlossaryError} When the file is unreadable or malformed.
 */
export function loadGlossary(path) {
  let glossary;
  try {
    glossary = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GlossaryError(`cannot read glossary ${path}: ${error.message}`);
  }
  assertRecord(glossary, "glossary");
  if (glossary.version !== SUPPORTED_VERSION) {
    throw new GlossaryError(
      `glossary version must be ${SUPPORTED_VERSION}, received ${JSON.stringify(glossary.version)}`,
    );
  }
  assertRecord(glossary.style, "glossary.style");
  for (const [language, style] of Object.entries(glossary.style)) {
    assertNonEmptyString(language, "glossary.style language");
    assertNonEmptyString(style, `glossary.style.${language}`);
  }
  assertRecord(glossary.keepVerbatim, "glossary.keepVerbatim");
  for (const [term, note] of Object.entries(glossary.keepVerbatim)) {
    assertTerm(term, "glossary.keepVerbatim term");
    assertNonEmptyString(note, `glossary.keepVerbatim.${term}`);
  }
  assertRecord(glossary.preferredTranslations, "glossary.preferredTranslations");
  for (const [term, translations] of Object.entries(glossary.preferredTranslations)) {
    assertNonEmptyString(term, "glossary.preferredTranslations term");
    assertRecord(translations, `glossary.preferredTranslations.${term}`);
    for (const [language, translation] of Object.entries(translations)) {
      assertNonEmptyString(language, `glossary.preferredTranslations.${term} language`);
      assertNonEmptyString(translation, `glossary.preferredTranslations.${term}.${language}`);
    }
  }
  if (!Array.isArray(glossary.intentionallyIdentical)) {
    throw new GlossaryError("glossary.intentionallyIdentical must be an array");
  }
  for (const term of glossary.intentionallyIdentical) {
    assertTerm(term, "glossary.intentionallyIdentical term");
  }
  return glossary;
}

/**
 * Lists every term that stays identical in a target language. This is the
 * Shipi18n ignore-key set (so intentionally identical values do not report as
 * untranslated) and the catalog test's allowlist.
 *
 * @param {ReturnType<typeof loadGlossary>} glossary Validated glossary.
 * @returns {string[]} Keep-verbatim and intentionally identical terms.
 */
export function identicalTerms(glossary) {
  return [...Object.keys(glossary.keepVerbatim), ...glossary.intentionallyIdentical];
}

/**
 * Builds the system message prepended to every Shipi18n translation batch:
 * product context, target-language style, keep-verbatim terms, and preferred
 * domain vocabulary. Shipi18n's own user message still supplies the JSON-array
 * contract and placeholder rules.
 *
 * @param {ReturnType<typeof loadGlossary>} glossary Validated glossary.
 * @param {string} targetLanguage Target locale code, e.g. `"es"`.
 * @returns {string} System message for the Workers AI chat request.
 */
export function buildSystemPrompt(glossary, targetLanguage) {
  const style =
    glossary.style[targetLanguage] ??
    "Write concise, natural copy appropriate for an application interface.";
  const keepVerbatim = Object.keys(glossary.keepVerbatim).join(", ");
  const preferred = Object.entries(glossary.preferredTranslations)
    .flatMap(([term, translations]) => {
      const translation = translations[targetLanguage];
      return translation ? [`- ${term} → ${translation}`] : [];
    })
    .join("\n");
  const lines = [
    "You are translating the Meltiply product interface, a social publishing workspace for composing posts, scheduling distribution, and monitoring provider state.",
    `Target language: ${targetLanguage}.`,
    style,
    `Keep these product names, platform names, identifiers, and examples exactly as written: ${keepVerbatim}.`,
  ];
  if (preferred) {
    lines.push(`Use this domain vocabulary consistently:\n${preferred}`);
  }
  lines.push(
    "Return only the JSON array requested in the user message. Do not add reasoning, commentary, or markdown fences.",
  );
  return lines.join("\n\n");
}
