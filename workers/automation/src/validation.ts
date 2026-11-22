const unsafeIdentifierPattern = /[\u0000-\u001f\u007f\s]/;

export function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !unsafeIdentifierPattern.test(normalized)
    ? normalized
    : undefined;
}
