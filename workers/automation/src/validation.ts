// Shared identifier normalization for the Automation Worker (AUD-023):
// trims and rejects control characters, whitespace, and over-long provider
// identifiers before they reach provider adapters or the database.

/**
 * Validates and normalizes external provider identifiers (e.g. post IDs, comment IDs, operation IDs).
 * Rejects non-strings, internal whitespace, control characters, and identifiers longer than 512 characters (AUD-023).
 *
 * @param value - Untrusted value candidate for an external provider identifier.
 * @returns Trimmed string if non-empty, within 512 chars, and free of control chars/whitespace; undefined otherwise.
 *
 * @example
 * normalizeIdentifier("  123456789_post  ") // => "123456789_post"
 * normalizeIdentifier("bad id with spaces") // => undefined
 */
export function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(normalized)
    ? normalized
    : undefined;
}
