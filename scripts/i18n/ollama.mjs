import {
  assertTranslationArray,
  createStatusError,
  DEFAULT_TIMEOUT_MS,
  expectedTranslationCount,
  ProviderError,
} from "./provider.mjs";

const trailingSlashesPattern = /\/+$/u;

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";

const DEFAULT_CONTEXT_WINDOW = 8192;

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

function statusError(status, body, model) {
  return createStatusError("Ollama", status, body, {
    404: {
      message: `Ollama does not have model "${model}". Run \`ollama pull ${model}\`.`,
      kind: "provider",
      retryable: false,
    },
  });
}

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
  const endpoint = `${url.replace(trailingSlashesPattern, "")}/api/chat`;

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
