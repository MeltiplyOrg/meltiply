import type { Effect } from "effect";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  type ProviderAdapterErrorOptions,
} from "./failures";
import { providerCallEffect } from "./effect";
import type { RateLimitBudget } from "./rate-limit";
import type { ProviderRequestContext } from "./types";

export type ProviderHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface ProviderHttpRequest {
  acceptedStatuses?: readonly number[];
  body?: BodyInit;
  /**
   * Optional sanitizer invoked with the bounded, JSON-parsed body of a
   * non-accepted error response. It may return a ProviderErrorDiagnosis whose
   * sanitized code and quota/rate-limit flags refine the status-derived
   * failure classification. The raw body never leaves this boundary: only the
   * returned diagnosis reaches the thrown ProviderAdapterError.
   */
  classifyErrorBody?: (status: number, body: unknown) => ProviderErrorDiagnosis | undefined;
  headers?: HeadersInit;
  method: ProviderHttpMethod;
  responseType?: "empty" | "json" | "json_or_empty";
  sideEffectPossible?: boolean;
  url: string;
}

/**
 * Provider-specific diagnosis extracted from a safely parsed error body.
 * `code` is a sanitized failure code; `quotaExceeded`/`rateLimited` reclassify
 * status-derived 'auth' failures as 'quota'/'rate_limit' when the provider's
 * documented error reason proves that condition (e.g. Google 403 reasons).
 */
export interface ProviderErrorDiagnosis {
  code?: string;
  quotaExceeded?: boolean;
  rateLimited?: boolean;
}

export interface ProviderHttpResponse<T> {
  body: T;
  headers: Headers;
  status: number;
}

export interface ProviderHttpClientOptions {
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
  maximumResponseBytes?: number;
  now?: () => Date;
  rateLimitBudget?: (headers: Headers) => RateLimitBudget | null;
  timeoutMilliseconds?: number;
}

const defaultMaximumResponseBytes = 256 * 1024;
const defaultTimeoutMilliseconds = 30_000;

/**
 * Asserts that a number is an integer within inclusive minimum and maximum bounds.
 * Used for strict validation of client configuration settings like byte limits and timeouts.
 * Returns the validated integer. Throws RangeError if value is non-integer or out of bounds.
 */
function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Validates and canonicalizes an allowed HTTPS origin URL string.
 * Requires https: scheme with no userinfo, path other than root '/', query, or fragment.
 * Returns the canonical origin string (e.g. 'https://graph.facebook.com').
 * Throws TypeError if the URL violates strict origin invariants.
 */
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new TypeError("provider origin must be a canonical HTTPS origin");
  }
  return url.origin;
}

/**
 * Validates an outbound provider request URL against configured allowed origins.
 * Guards against SSRF and unauthorized host navigation by enforcing HTTPS and membership in allowedOrigins.
 * Returns parsed URL object. Throws TypeError if scheme is not https: or origin is not allowed.
 */
function requestUrl(value: string, allowedOrigins: ReadonlySet<string>): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.has(url.origin)
  ) {
    throw new TypeError("provider request URL is outside the allowed origins");
  }
  return url;
}

/**
 * Validates and indexes acceptable non-2xx HTTP status codes for a request.
 * Enforces a maximum of 10 unique integer HTTP status codes within the 200..599 range.
 * Returns a Set of valid HTTP status codes. Throws TypeError on invalid status values.
 */
function acceptedStatuses(values: readonly number[] | undefined): Set<number> {
  if (!values) return new Set();
  if (
    values.length > 10 ||
    new Set(values).size !== values.length ||
    values.some((value) => !Number.isInteger(value) || value < 200 || value > 599)
  ) {
    throw new TypeError("provider accepted statuses are invalid");
  }
  return new Set(values);
}

/**
 * Parses a provider Retry-After header into a positive integer number of seconds.
 * Accepts either decimal second durations or HTTP-date strings relative to now, bounded to 86,400s (24h).
 * Returns ceil-rounded integer seconds, or undefined if header is missing, malformed, or out of bounds.
 */
function retryAfterSeconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? Math.ceil(numeric)
    : Math.ceil((new Date(value).getTime() - now.getTime()) / 1_000);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}

/**
 * Streams an HTTP response body into memory with strict byte limit enforcement.
 * Inspects Content-Length upfront and terminates stream reader early if bytes exceed maximumBytes,
 * protecting Worker isolates from heap exhaustion from large untrusted payloads.
 * Returns Uint8Array of body bytes. Throws TypeError if size exceeds limit.
 */
async function boundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new TypeError("provider response exceeds the maximum size");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new TypeError("provider response exceeds the maximum size");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Cancels the readable stream of an unused or rejected response body.
 * Safely frees underlying network resources without throwing unhandled rejection errors.
 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; preserve its protocol outcome.
  }
}

/**
 * Helper to construct a ProviderAdapterError from classified failure attributes.
 * Synthesizes status, timeout, code, parsed-body diagnosis, and ambiguity flags.
 * Optional causes and credential-free request facts reach sanitized error logs;
 * public classification and retry behavior remain unchanged.
 */
function adapterError(
  input: {
    code: string;
    malformedResponse?: boolean;
    quotaExceeded?: boolean;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
    sideEffectPossible: boolean;
    status?: number;
    timedOut?: boolean;
  },
  options?: ProviderAdapterErrorOptions,
): ProviderAdapterError {
  return new ProviderAdapterError(classifyProviderFailure(input), options);
}

export class ProviderHttpClient {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #fetch: typeof fetch;
  readonly #maximumResponseBytes: number;
  readonly #now: () => Date;
  readonly #rateLimitBudget: ((headers: Headers) => RateLimitBudget | null) | undefined;
  readonly #timeoutMilliseconds: number;

  /**
   * Initializes a hardened ProviderHttpClient scoped to a set of canonical HTTPS origins.
   * Validates unique allowed origins, configures response byte ceilings (up to 1 MiB),
   * request timeouts (up to 120s), and optional rate limit budget extractors.
   * Throws TypeError on duplicate or invalid origins, or RangeError on out-of-bound limits.
   */
  constructor(options: ProviderHttpClientOptions) {
    const origins = options.allowedOrigins.map(origin);
    if (origins.length < 1 || new Set(origins).size !== origins.length) {
      throw new TypeError("provider HTTP client requires unique allowed origins");
    }
    this.#allowedOrigins = new Set(origins);
    this.#fetch = options.fetch ?? fetch;
    this.#maximumResponseBytes = boundedInteger(
      "maximumResponseBytes",
      options.maximumResponseBytes ?? defaultMaximumResponseBytes,
      1,
      1024 * 1024,
    );
    this.#timeoutMilliseconds = boundedInteger(
      "timeoutMilliseconds",
      options.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      1,
      120_000,
    );
    this.#now = options.now ?? (() => new Date());
    this.#rateLimitBudget = options.rateLimitBudget;
  }

  /**
   * Executes a hardened HTTP request against an allowed provider endpoint.
   * Denies redirects that the caller did not explicitly accept as protocol
   * status (`redirect: 'manual'` plus an explicit 3xx failure, because the
   * Workers runtime has no 'error' mode), applies timeout abortion, response
   * byte bounds, JSON decoding, status code validation, and rate limit budget
   * extraction into context metadata. Calls fetch with the global receiver
   * required by Workers, rather than exposing this client as its receiver.
   * Returns typed ProviderHttpResponse containing decoded body, headers, and status code.
   * Throws ProviderAdapterError on HTTP failure, redirect, timeout, or malformed JSON;
   * internal causes and origin/method/status facts are retained for sanitized logs.
   * JSON parse errors are summarized because native messages can contain response bytes.
   */
  async request<T>(
    context: ProviderRequestContext,
    request: ProviderHttpRequest,
  ): Promise<ProviderHttpResponse<T>> {
    const url = requestUrl(request.url, this.#allowedOrigins);
    const accepted = acceptedStatuses(request.acceptedStatuses);
    const sideEffectPossible = request.sideEffectPossible === true;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) abort();
    else context.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
    }, this.#timeoutMilliseconds);
    const cleanup = () => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    };

    let response: Response;
    try {
      const headers = new Headers(request.headers);
      if (!headers.has("Accept")) headers.set("Accept", "application/json");
      response = await this.#fetch.call(globalThis, url, {
        ...(request.body === undefined ? {} : { body: request.body }),
        cache: "no-store",
        headers,
        method: request.method,
        // Workers implements only 'follow' and 'manual'; 'error' throws a
        // TypeError before any socket is opened. Redirects are therefore denied
        // explicitly below, which also keeps the bearer token and any write from
        // reaching a host the allowlist never approved.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      const abortFailure =
        timedOut ||
        (cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name));
      cleanup();
      throw adapterError(
        {
          code: abortFailure ? "provider_http_timeout" : "provider_http_request_failed",
          sideEffectPossible,
          ...(abortFailure ? { timedOut: true } : {}),
        },
        { cause, request: { method: request.method, origin: url.origin } },
      );
    }

    try {
      const rateLimitBudget = this.#rateLimitBudget?.(response.headers);
      context.metadata = rateLimitBudget ? { rateLimitBudget } : undefined;
      if (response.status >= 300 && response.status < 400 && !accepted.has(response.status)) {
        await cancelBody(response);
        throw adapterError(
          {
            code: "provider_http_redirect",
            sideEffectPossible,
            status: response.status,
          },
          {
            request: {
              method: request.method,
              origin: url.origin,
              status_code: response.status,
            },
          },
        );
      }
      if (!response.ok && !accepted.has(response.status)) {
        let diagnosis: ProviderErrorDiagnosis | undefined;
        if (request.classifyErrorBody) {
          // Read the error body through the same byte bound as success
          // responses, then hand only the parsed value to the sanitizer so raw
          // provider payloads are never retained in the failure.
          let parsed: unknown;
          try {
            const bytes = await boundedBody(response, this.#maximumResponseBytes);
            parsed =
              bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            await cancelBody(response);
          }
          try {
            diagnosis = request.classifyErrorBody(response.status, parsed);
          } catch {
            diagnosis = undefined;
          }
        } else {
          await cancelBody(response);
        }
        throw adapterError(
          {
            code: diagnosis?.code ?? `provider_http_${response.status}`,
            quotaExceeded: diagnosis?.quotaExceeded,
            rateLimited: diagnosis?.rateLimited,
            retryAfterSeconds: retryAfterSeconds(response.headers.get("Retry-After"), this.#now()),
            sideEffectPossible,
            status: response.status,
          },
          {
            request: {
              method: request.method,
              origin: url.origin,
              status_code: response.status,
            },
          },
        );
      }

      const responseType = request.responseType ?? "json";
      if (responseType === "empty") {
        await cancelBody(response);
        return {
          body: undefined as T,
          headers: response.headers,
          status: response.status,
        };
      }
      try {
        const bytes = await boundedBody(response, this.#maximumResponseBytes);
        if (bytes.byteLength === 0 && responseType === "json_or_empty") {
          return {
            body: undefined as T,
            headers: response.headers,
            status: response.status,
          };
        }
        if (bytes.byteLength === 0) {
          throw new TypeError("provider response is empty");
        }
        const contentType = response.headers.get("Content-Type")?.toLowerCase();
        if (!contentType?.includes("application/json")) {
          throw new TypeError("provider response is not JSON");
        }
        return {
          body: JSON.parse(new TextDecoder().decode(bytes)) as T,
          headers: response.headers,
          status: response.status,
        };
      } catch (cause) {
        const abortFailure = controller.signal.aborted;
        throw adapterError(
          {
            code: abortFailure ? "provider_http_timeout" : "provider_http_malformed_response",
            sideEffectPossible,
            status: response.status,
            ...(abortFailure ? { timedOut: true } : { malformedResponse: true }),
          },
          {
            // JSON.parse may quote provider response bytes in its exception.
            cause:
              cause instanceof SyntaxError
                ? new SyntaxError("Provider response is not valid JSON")
                : cause,
            request: {
              method: request.method,
              origin: url.origin,
              status_code: response.status,
            },
          },
        );
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Effect-wrapped hardened HTTP request against an allowed provider endpoint.
   * Delegates to the shared provider-call lift so transport composes without
   * Promise/throw flows: the Effect fiber's interruption aborts the underlying
   * fetch via the child context signal, and caller-provided abort signals are
   * forwarded too. Provider transport failures surface as the original
   * ProviderAdapterError (preserving classification, retryAfterSeconds, and
   * ambiguous outcomes); unexpected throws become sanitized deterministic
   * provider_unexpected failures without retaining the raw error.
   * Returns Effect resolving to the typed ProviderHttpResponse. Example:
   * `client.requestEffect(ctx, { method: "GET", url })` → `Effect<ProviderHttpResponse<T>, ProviderAdapterError>`.
   */
  requestEffect<T>(
    context: ProviderRequestContext,
    request: ProviderHttpRequest,
  ): Effect.Effect<ProviderHttpResponse<T>, ProviderAdapterError> {
    return providerCallEffect(context, (child) => this.request<T>(child, request));
  }
}
