import type { Effect } from "effect";
import type { Platform } from "@meltiply/domain";

import { providerCallEffect } from "./effect";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  type ProviderFailureInput,
  type ProviderRequestDiagnostic,
} from "./failures";
import { extractRateLimitBudget } from "./rate-limit";
import type { ProviderRequestContext } from "./types";

export type ProviderHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type ProviderHttpResponseType = "empty" | "json" | "json_or_empty";

export interface ProviderHttpRequest {
  acceptedStatuses?: readonly number[];
  body?: BodyInit;
  /**
   * Refines the status-derived classification of a non-accepted response from
   * its bounded, parsed body. Only the returned diagnosis leaves the client.
   */
  classifyErrorBody?: (status: number, body: unknown) => ProviderErrorDiagnosis | undefined;
  headers?: HeadersInit;
  method: ProviderHttpMethod;
  responseType?: ProviderHttpResponseType;
  /** Keeps JSON integers beyond `Number.MAX_SAFE_INTEGER` as their exact decimal strings. */
  preserveLargeIntegers?: boolean;
  sideEffectPossible?: boolean;
  url: string;
}

export interface ProviderErrorDiagnosis {
  code?: string;
  quotaExceeded?: boolean;
  rateLimited?: boolean;
}

export interface ProviderHttpResponse {
  body: unknown;
  headers: Headers;
  status: number;
}

export interface ProviderHttpClientOptions {
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
  maximumResponseBytes?: number;
  now?: () => Date;
  /** Selects the rate-limit header parser whose budget is recorded on the request context. */
  platform?: Platform;
  timeoutMilliseconds?: number;
}

const defaultMaximumResponseBytes = 256 * 1024;
const maximumResponseBytesCeiling = 1024 * 1024;
const defaultTimeoutMilliseconds = 30_000;
const timeoutMillisecondsCeiling = 120_000;
const maxRetryAfterSeconds = 86_400;
const maxAcceptedStatuses = 10;
const unsafeIntegerSourcePattern = /^-?\d+$/;
const utf8Decoder = new TextDecoder();

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

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

function acceptedStatuses(values: readonly number[] | undefined): Set<number> {
  if (!values) return new Set();
  if (
    values.length > maxAcceptedStatuses ||
    new Set(values).size !== values.length ||
    values.some((value) => !Number.isInteger(value) || value < 200 || value > 599)
  ) {
    throw new TypeError("provider accepted statuses are invalid");
  }
  return new Set(values);
}

/** `Retry-After` is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function retryAfterSeconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? Math.ceil(numeric)
    : Math.ceil((new Date(value).getTime() - now.getTime()) / 1_000);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= maxRetryAfterSeconds
    ? seconds
    : undefined;
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const rawLength = response.headers.get("Content-Length");
  const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new TypeError("provider response exceeds the maximum size");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const initialCapacity = Number.isInteger(contentLength) && contentLength > 0 ? contentLength : 0;
  let buffer: Uint8Array | undefined =
    initialCapacity > 0 ? new Uint8Array(initialCapacity) : undefined;
  let singleChunk: Uint8Array | undefined;
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const piece = chunk.value;
      if (piece.byteLength === 0) continue;
      const nextLength = length + piece.byteLength;
      if (nextLength > maximumBytes) {
        await reader.cancel();
        throw new TypeError("provider response exceeds the maximum size");
      }
      if (!buffer) {
        if (!singleChunk) {
          singleChunk = piece;
          length = nextLength;
          continue;
        }
        buffer = new Uint8Array(
          Math.min(maximumBytes, Math.max(nextLength, singleChunk.byteLength * 2)),
        );
        buffer.set(singleChunk, 0);
        singleChunk = undefined;
      } else if (nextLength > buffer.byteLength) {
        const grown = new Uint8Array(
          Math.min(maximumBytes, Math.max(nextLength, buffer.byteLength * 2)),
        );
        grown.set(buffer.subarray(0, length), 0);
        buffer = grown;
      }
      buffer.set(piece, length);
      length = nextLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (singleChunk) return singleChunk;
  if (!buffer) return new Uint8Array();
  return length === buffer.byteLength ? buffer : buffer.subarray(0, length);
}

function parseJsonBytes(bytes: Uint8Array, preserveLargeIntegers = false): unknown {
  return JSON.parse(
    utf8Decoder.decode(bytes),
    preserveLargeIntegers
      ? (_key, value: unknown, source?: { source?: string }) =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          !Number.isSafeInteger(value) &&
          source?.source &&
          unsafeIntegerSourcePattern.test(source.source)
            ? source.source
            : value
      : undefined,
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function failure(
  input: ProviderFailureInput,
  request: ProviderRequestDiagnostic,
  cause?: unknown,
): ProviderAdapterError {
  return new ProviderAdapterError(classifyProviderFailure(input), {
    ...(cause === undefined ? {} : { cause }),
    request,
  });
}

/**
 * Fetch boundary for every provider call: HTTPS origin allowlist, no redirects,
 * timeout and caller abort, bounded bodies, JSON decoding, and failure
 * classification. Rate-limit budgets from response headers are written to
 * `context.metadata`.
 */
export class ProviderHttpClient {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #fetch: typeof fetch;
  readonly #maximumResponseBytes: number;
  readonly #now: () => Date;
  readonly #platform: Platform | undefined;
  readonly #timeoutMilliseconds: number;

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
      maximumResponseBytesCeiling,
    );
    this.#timeoutMilliseconds = boundedInteger(
      "timeoutMilliseconds",
      options.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
      1,
      timeoutMillisecondsCeiling,
    );
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform;
  }

  async request(
    context: ProviderRequestContext,
    request: ProviderHttpRequest,
  ): Promise<ProviderHttpResponse> {
    const url = requestUrl(request.url, this.#allowedOrigins);
    const accepted = acceptedStatuses(request.acceptedStatuses);
    const sideEffectPossible = request.sideEffectPossible === true;
    const diagnostic: ProviderRequestDiagnostic = { method: request.method, origin: url.origin };
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
        // Workers supports only "follow" and "manual"; redirects are rejected below.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted =
        timedOut ||
        (cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name));
      cleanup();
      throw failure(
        {
          code: aborted ? "provider_http_timeout" : "provider_http_request_failed",
          sideEffectPossible,
          ...(aborted ? { timedOut: true } : {}),
        },
        diagnostic,
        cause,
      );
    }

    try {
      const rateLimitBudget = this.#platform
        ? extractRateLimitBudget(this.#platform, response.headers)
        : null;
      context.metadata = rateLimitBudget ? { rateLimitBudget } : undefined;
      const responseDiagnostic = { ...diagnostic, status_code: response.status };
      if (response.status >= 300 && response.status < 400 && !accepted.has(response.status)) {
        await cancelBody(response);
        throw failure(
          { code: "provider_http_redirect", sideEffectPossible, status: response.status },
          responseDiagnostic,
        );
      }
      if (!response.ok && !accepted.has(response.status)) {
        const diagnosis = await this.#diagnose(response, request.classifyErrorBody);
        throw failure(
          {
            code: diagnosis?.code ?? `provider_http_${response.status}`,
            quotaExceeded: diagnosis?.quotaExceeded,
            rateLimited: diagnosis?.rateLimited,
            retryAfterSeconds: retryAfterSeconds(response.headers.get("Retry-After"), this.#now()),
            sideEffectPossible,
            status: response.status,
          },
          responseDiagnostic,
        );
      }

      const responseType = request.responseType ?? "json";
      const empty = { body: undefined, headers: response.headers, status: response.status };
      if (responseType === "empty") {
        await cancelBody(response);
        return empty;
      }
      try {
        const bytes = await boundedBody(response, this.#maximumResponseBytes);
        if (bytes.byteLength === 0 && responseType === "json_or_empty") return empty;
        if (bytes.byteLength === 0) throw new TypeError("provider response is empty");
        if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
          throw new TypeError("provider response is not JSON");
        }
        return {
          body: parseJsonBytes(bytes, request.preserveLargeIntegers),
          headers: response.headers,
          status: response.status,
        };
      } catch (cause) {
        const aborted = controller.signal.aborted;
        throw failure(
          {
            code: aborted ? "provider_http_timeout" : "provider_http_malformed_response",
            sideEffectPossible,
            status: response.status,
            ...(aborted ? { timedOut: true } : { malformedResponse: true }),
          },
          responseDiagnostic,
          // JSON.parse messages can quote response bytes.
          cause instanceof SyntaxError
            ? new SyntaxError("Provider response is not valid JSON")
            : cause,
        );
      }
    } finally {
      cleanup();
    }
  }

  requestEffect(
    context: ProviderRequestContext,
    request: ProviderHttpRequest,
  ): Effect.Effect<ProviderHttpResponse, ProviderAdapterError> {
    return providerCallEffect(context, (child) => this.request(child, request));
  }

  async #diagnose(
    response: Response,
    classifyErrorBody: ProviderHttpRequest["classifyErrorBody"],
  ): Promise<ProviderErrorDiagnosis | undefined> {
    if (!classifyErrorBody) {
      await cancelBody(response);
      return undefined;
    }
    let parsed: unknown;
    try {
      const bytes = await boundedBody(response, this.#maximumResponseBytes);
      parsed = bytes.byteLength === 0 ? undefined : parseJsonBytes(bytes);
    } catch {
      await cancelBody(response);
    }
    try {
      return classifyErrorBody(response.status, parsed);
    } catch {
      return undefined;
    }
  }
}
