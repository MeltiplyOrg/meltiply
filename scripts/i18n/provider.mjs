/**
 * Provider failure with enough classification for retry, fallback, and
 * actionable terminal errors. Messages never include the prompt or credentials.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message Safe, actionable description.
   * @param {{status?: number, kind?: "auth" | "transient" | "malformed" | "provider", retryable?: boolean, cause?: unknown}} [options]
   */
  constructor(message, { status, kind = "provider", retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

/**
 * Accepts only the bare JSON array a translation provider was asked for.
 * Reasoning text, markdown fences, prose, or non-string entries are malformed
 * output: the fallback model gets a chance instead of a partial catalog. When
 * the prompt carries Shipi18n's string array, the returned length must match it
 * too, so a truncated batch cannot escape the fallback path.
 *
 * @param {string} text Raw model text.
 * @param {number | undefined} expectedCount Number of strings in the batch.
 * @throws {ProviderError} When the output is not a correctly sized string array.
 */
export function assertTranslationArray(text, expectedCount) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("the model returned output that is not a bare JSON array", {
      kind: "malformed",
      retryable: true,
    });
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new ProviderError("the model returned JSON that is not an array of translated strings", {
      kind: "malformed",
      retryable: true,
    });
  }
  if (expectedCount !== undefined && parsed.length !== expectedCount) {
    throw new ProviderError(
      `the model returned ${parsed.length} translated strings for a batch of ${expectedCount}`,
      { kind: "malformed", retryable: true },
    );
  }
}

/**
 * Reads the batch size from Shipi18n's user prompt. When the marker is absent
 * or the array cannot be parsed, length validation is skipped rather than
 * failing a request the adapter does not fully understand.
 *
 * @param {string} prompt Shipi18n batch prompt.
 * @returns {number | undefined} Number of strings the model must return.
 */
export function expectedTranslationCount(prompt) {
  const marker = "STRINGS TO TRANSLATE (JSON array):";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) return undefined;
  const start = prompt.indexOf("[", markerIndex + marker.length);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < prompt.length; index += 1) {
    const character = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth > 0) continue;
      try {
        const texts = JSON.parse(prompt.slice(start, index + 1));
        return Array.isArray(texts) ? texts.length : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
