import { readFileSync } from "node:fs";

const SUPPORTED_VERSION = 1;

export class GlossaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "GlossaryError";
  }
}

function assertNonEmptyString(value, description) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GlossaryError(`${description} must be a non-empty string`);
  }
}

function assertTerm(value, description) {
  assertNonEmptyString(value, description);
  if (value.includes(",")) {
    throw new GlossaryError(`${description} must not contain a comma: ${JSON.stringify(value)}`);
  }
}

function assertRecord(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GlossaryError(`${description} must be an object`);
  }
}

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

export function identicalTerms(glossary) {
  return [...Object.keys(glossary.keepVerbatim), ...glossary.intentionallyIdentical];
}

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
