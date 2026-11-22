import { isRetryableStatus } from "./retry.mjs";

export const DEFAULT_TIMEOUT_MS = 120_000;

export class ProviderError extends Error {
  constructor(message, { status, kind = "provider", retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

export function createStatusError(providerName, status, body, overrides = {}) {
  const detail = body.trim().slice(0, 500);
  const suffix = detail ? `: ${detail}` : "";
  const specific = overrides[status];
  if (specific) {
    return new ProviderError(`${specific.message}${suffix}`, {
      status,
      kind: specific.kind ?? "provider",
      retryable: specific.retryable ?? false,
    });
  }
  if (isRetryableStatus(status)) {
    return new ProviderError(
      `${providerName} is temporarily unavailable (HTTP ${status}).${suffix}`,
      {
        status,
        kind: "transient",
        retryable: true,
      },
    );
  }
  return new ProviderError(`${providerName} request failed (HTTP ${status}).${suffix}`, {
    status,
    kind: "provider",
    retryable: false,
  });
}

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
