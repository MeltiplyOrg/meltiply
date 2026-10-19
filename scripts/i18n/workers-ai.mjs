import { isRetryableStatus } from "./retry.mjs";

const WORKERS_AI_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

/** Default request timeout for one Workers AI completion. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Provider failure with enough classification for retry, fallback, and
 * actionable terminal errors. Messages never include the prompt or the token.
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
 * Maps an HTTP failure to an actionable provider error. Credential failures are
 * terminal, retryable statuses carry the transient flag, and everything else
 * surfaces the bounded response detail without including the prompt or token.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Response body used for a bounded error suffix.
 * @returns {ProviderError} Classified error.
 */
function statusError(status, body) {
  const detail = body.trim().slice(0, 500);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new ProviderError(
      `Workers AI rejected the credentials (HTTP ${status}). Check WORKERS_AI_API_TOKEN and its Workers AI permission.${suffix}`,
      { status, kind: "auth", retryable: false },
    );
  }
  if (isRetryableStatus(status)) {
    return new ProviderError(`Workers AI is temporarily unavailable (HTTP ${status}).${suffix}`, {
      status,
      kind: "transient",
      retryable: true,
    });
  }
  return new ProviderError(`Workers AI request failed (HTTP ${status}).${suffix}`, {
    status,
    kind: "provider",
    retryable: false,
  });
}

/**
 * Accepts only the bare JSON array Shipi18n requested. Reasoning text, markdown
 * fences, prose, or non-string entries are malformed output: the fallback model
 * gets a chance instead of a partial catalog. When the prompt carries
 * Shipi18n's string array, the returned length must match it too, so a truncated
 * batch cannot escape the fallback path.
 */
function assertTranslationArray(text, expectedCount) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("Workers AI returned output that is not a bare JSON array", {
      kind: "malformed",
      retryable: true,
    });
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new ProviderError("Workers AI returned JSON that is not an array of translated strings", {
      kind: "malformed",
      retryable: true,
    });
  }
  if (expectedCount !== undefined && parsed.length !== expectedCount) {
    throw new ProviderError(
      `Workers AI returned ${parsed.length} translated strings for a batch of ${expectedCount}`,
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
function expectedTranslationCount(prompt) {
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

/**
 * Creates a `TranslationProvider` backed by the direct Workers AI run endpoint.
 *
 * The request fixes `temperature: 0` and the supplied seed, bounded
 * `max_tokens`, and a request timeout. `complete` makes one model call and
 * classifies failures; retry and model fallback compose around it.
 *
 * @param {object} options
 * @param {string} options.accountId Cloudflare account identifier.
 * @param {string} options.apiToken Workers AI-scoped API token.
 * @param {string} options.model Workers AI model id, e.g. `@cf/qwen/qwen3-30b-a3b-fp8`.
 * @param {string} [options.systemPrompt] Product context, style, and glossary.
 * @param {number} [options.seed] Sampling seed; the same input and model aim for repeatable drafts.
 * @param {number} [options.timeoutMs] Per-request timeout.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch for tests.
 * @returns {{name: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}}
 */
export function createWorkersAiProvider({
  accountId,
  apiToken,
  model,
  systemPrompt = "",
  seed,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  for (const [name, value] of Object.entries({ accountId, apiToken, model })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} is required for Workers AI translation`);
    }
  }
  const endpoint = `${WORKERS_AI_ENDPOINT}/${accountId}/ai/run/${model}`;

  return {
    name: model,
    async complete(prompt, { maxTokens = 8192 } = {}) {
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: prompt });

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages,
            temperature: 0,
            seed,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ProviderError(
          `Workers AI request could not complete: ${error.name === "TimeoutError" ? "timed out" : error.message}`,
          { kind: "transient", retryable: true, cause: error },
        );
      }

      const body = await response.text();
      if (!response.ok) throw statusError(response.status, body);

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new ProviderError("Workers AI returned a response that is not JSON", {
          kind: "malformed",
          retryable: true,
        });
      }
      if (payload?.success === false) {
        const message = Array.isArray(payload.errors)
          ? payload.errors.map((error) => error?.message ?? String(error)).join("; ")
          : "unknown Workers AI error";
        throw new ProviderError(`Workers AI rejected the request: ${message}`, {
          kind: "provider",
          retryable: false,
        });
      }
      const text = payload?.result?.response;
      if (typeof text !== "string" || text.trim() === "") {
        throw new ProviderError("Workers AI response did not contain model text", {
          kind: "malformed",
          retryable: true,
        });
      }
      assertTranslationArray(text.trim(), expectedTranslationCount(prompt));
      return text.trim();
    },
  };
}

/**
 * Falls back to a second model when the primary is unavailable or returns
 * malformed output. Authentication failures never fall back: the same token
 * would fail identically, so the error surfaces immediately.
 *
 * @param {{complete: (...args: any[]) => Promise<string>}} primary Preferred provider.
 * @param {{name?: string, complete: (...args: any[]) => Promise<string>}} fallback Secondary provider.
 * @returns {{name: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}}
 */
export function withFallback(primary, fallback) {
  return {
    name: `${primary.name ?? "primary"} → ${fallback.name ?? "fallback"}`,
    async complete(prompt, options) {
      try {
        return await primary.complete(prompt, options);
      } catch (error) {
        if (error?.kind === "auth" || !(error?.retryable || error?.kind === "malformed")) {
          throw error;
        }
        return fallback.complete(prompt, options);
      }
    },
  };
}
