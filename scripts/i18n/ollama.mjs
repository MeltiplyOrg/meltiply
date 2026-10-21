import { assertTranslationArray, expectedTranslationCount, ProviderError } from "./provider.mjs";
import { isRetryableStatus } from "./retry.mjs";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";

/** Default request timeout and context window for one local completion. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Maps a fetch failure to an actionable local-provider error. A missing Ollama
 * process is terminal and says how to start it; timeouts and unexpected
 * transport failures remain retryable.
 *
 * @param {unknown} error Fetch rejection.
 * @param {string} url Ollama base URL.
 * @param {string} model Requested model.
 * @returns {ProviderError} Classified error.
 */
function connectionError(error, url, model) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new ProviderError(`Ollama did not respond within the timeout at ${url}`, {
      kind: "transient",
      retryable: true,
      cause: error,
    });
  }
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"].includes(code)) {
    return new ProviderError(
      `Ollama is not reachable at ${url}. Install Ollama, run \`ollama serve\`, then \`ollama pull ${model}\`.`,
      { kind: "provider", retryable: false, cause: error },
    );
  }
  return new ProviderError(`Ollama request failed: ${error?.message ?? String(error)}`, {
    kind: "transient",
    retryable: true,
    cause: error,
  });
}

/**
 * Maps an HTTP failure to an actionable provider error. A missing model names
 * the exact `ollama pull` command; rate limits and server faults retry.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Response body used for a bounded error suffix.
 * @param {string} model Requested model.
 * @returns {ProviderError} Classified error.
 */
function statusError(status, body, model) {
  const detail = body.trim().slice(0, 500);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 404) {
    return new ProviderError(
      `Ollama does not have model "${model}". Run \`ollama pull ${model}\`.${suffix}`,
      { status, kind: "provider", retryable: false },
    );
  }
  if (isRetryableStatus(status)) {
    return new ProviderError(`Ollama is temporarily unavailable (HTTP ${status}).${suffix}`, {
      status,
      kind: "transient",
      retryable: true,
    });
  }
  return new ProviderError(`Ollama request failed (HTTP ${status}).${suffix}`, {
    status,
    kind: "provider",
    retryable: false,
  });
}

/**
 * Creates a credential-free `TranslationProvider` backed by a local Ollama
 * server. The request fixes `temperature: 0`, the supplied seed, a bounded
 * prediction length, a context window sized for a translation batch, and
 * `think: false` so reasoning models answer without analysis tokens. No
 * account, API key, or network egress is involved.
 *
 * @param {object} options
 * @param {string} [options.url] Ollama base URL.
 * @param {string} [options.model] Locally pulled model, e.g. `qwen3:8b`.
 * @param {string} [options.systemPrompt] Product context, style, and glossary.
 * @param {number} [options.seed] Sampling seed.
 * @param {number} [options.timeoutMs] Per-request timeout.
 * @param {number} [options.contextWindow] `num_ctx` for the batch prompt.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch for tests.
 * @returns {{name: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}}
 */
export function createOllamaProvider({
  url = DEFAULT_OLLAMA_URL,
  model = DEFAULT_OLLAMA_MODEL,
  systemPrompt = "",
  seed,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  fetchImpl = fetch,
}) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("an Ollama base URL is required");
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("an Ollama model is required");
  }
  const endpoint = `${url.replace(/\/+$/u, "")}/api/chat`;

  return {
    name: `ollama:${model}`,
    async complete(prompt, { maxTokens = 8192 } = {}) {
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: prompt });

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            think: false,
            options: {
              temperature: 0,
              seed,
              num_predict: maxTokens,
              num_ctx: contextWindow,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw connectionError(error, url, model);
      }

      const body = await response.text();
      if (!response.ok) throw statusError(response.status, body, model);

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new ProviderError("Ollama returned a response that is not JSON", {
          kind: "malformed",
          retryable: true,
        });
      }
      if (payload?.error) {
        throw new ProviderError(`Ollama rejected the request: ${payload.error}`, {
          kind: "provider",
          retryable: false,
        });
      }
      const text = payload?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new ProviderError("Ollama response did not contain model text", {
          kind: "malformed",
          retryable: true,
        });
      }
      assertTranslationArray(text.trim(), expectedTranslationCount(prompt));
      return text.trim();
    },
  };
}
