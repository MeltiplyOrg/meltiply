import { assertTranslationArray, expectedTranslationCount, ProviderError } from "./provider.mjs";
import { isRetryableStatus } from "./retry.mjs";

const WORKERS_AI_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

/** Default request timeout for one Workers AI completion. */
const DEFAULT_TIMEOUT_MS = 120_000;

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
 * Extracts model text from either Workers AI response shape: the legacy
 * `result.response` string or the OpenAI-compatible
 * `result.choices[0].message.content`. A reasoning-only response is malformed:
 * the analysis text is not a translation.
 *
 * @param {any} payload Parsed Workers AI envelope.
 * @returns {string | undefined} Trimmed model text when present.
 */
function modelText(payload) {
  const result = payload?.result;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim() !== "") return content.trim();
  const legacy = result?.response;
  if (typeof legacy === "string" && legacy.trim() !== "") return legacy.trim();
  return undefined;
}

/**
 * Creates a `TranslationProvider` backed by the direct Workers AI run endpoint.
 *
 * The request fixes `temperature: 0` and the supplied seed, bounded
 * `max_tokens`, and a request timeout. `requestOptions` supplies
 * model-specific flags such as disabling reasoning. `complete` makes one model
 * call and classifies failures; retry and model fallback compose around it.
 *
 * @param {object} options
 * @param {string} options.accountId Cloudflare account identifier.
 * @param {string} options.apiToken Workers AI-scoped API token.
 * @param {string} options.model Workers AI model id, e.g. `@cf/zai-org/glm-4.7-flash`.
 * @param {string} [options.systemPrompt] Product context, style, and glossary.
 * @param {number} [options.seed] Sampling seed; the same input and model aim for repeatable drafts.
 * @param {number} [options.timeoutMs] Per-request timeout.
 * @param {Record<string, unknown>} [options.requestOptions] Model-specific body flags, merged before the fixed request fields.
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
  requestOptions = {},
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
            ...requestOptions,
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
      const text = modelText(payload);
      if (!text) {
        throw new ProviderError("Workers AI response did not contain model text", {
          kind: "malformed",
          retryable: true,
        });
      }
      assertTranslationArray(text, expectedTranslationCount(prompt));
      return text;
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
