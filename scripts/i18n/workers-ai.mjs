import {
  assertTranslationArray,
  createStatusError,
  DEFAULT_TIMEOUT_MS,
  expectedTranslationCount,
  ProviderError,
} from "./provider.mjs";

const WORKERS_AI_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

function statusError(status, body) {
  const authFailure = {
    message: `Workers AI rejected the credentials (HTTP ${status}). Check WORKERS_AI_API_TOKEN and its Workers AI permission.`,
    kind: "auth",
    retryable: false,
  };
  return createStatusError("Workers AI", status, body, {
    401: authFailure,
    403: authFailure,
  });
}

function modelText(payload) {
  const result = payload?.result;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim() !== "") return content.trim();
  const legacy = result?.response;
  if (typeof legacy === "string" && legacy.trim() !== "") return legacy.trim();
  return undefined;
}

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
