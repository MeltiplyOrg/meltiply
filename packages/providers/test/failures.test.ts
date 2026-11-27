import { describe, expect, it } from "vite-plus/test";

import {
  ambiguousFailure,
  classifyProviderFailure,
  failureDiagnostic,
  isHttp404,
  isUncertainFailure,
  malformed,
  normalizeProviderFailure,
  ProviderAdapterError,
  rejected,
  rejection,
} from "../src/failures";
import type { ProviderFailureClass } from "../src/types";

const MESSAGES: Record<ProviderFailureClass, string> = {
  ambiguous: "The provider outcome could not be confirmed.",
  auth: "The provider authorization must be refreshed.",
  deterministic: "The provider rejected this request.",
  quota: "The provider quota has been reached.",
  rate_limit: "The provider rate limit has been reached.",
  timeout: "The provider request timed out before an outcome was confirmed.",
  transient: "The provider is temporarily unavailable.",
};

const failure = (
  classification: ProviderFailureClass,
  retryable: boolean,
  code = `provider_${classification}`,
) => ({ classification, code, message: MESSAGES[classification], retryable });

describe("classifyProviderFailure", () => {
  it.each([
    ["a timed-out write", { sideEffectPossible: true, timedOut: true }, "ambiguous", false],
    [
      "a malformed answer to a write",
      { sideEffectPossible: true, malformedResponse: true, status: 200 },
      "ambiguous",
      false,
    ],
    ["a write with no status", { sideEffectPossible: true }, "ambiguous", false],
    [
      "a write refused with a status",
      { sideEffectPossible: true, status: 400 },
      "deterministic",
      false,
    ],
    ["a timed-out read", { timedOut: true }, "timeout", true],
    ["a 408", { status: 408 }, "timeout", true],
    ["a reported quota", { quotaExceeded: true, status: 400 }, "quota", false],
    ["a reported rate limit", { rateLimited: true, status: 400 }, "rate_limit", true],
    ["a 401", { status: 401 }, "auth", false],
    ["a 403", { status: 403 }, "auth", false],
    ["a 402", { status: 402 }, "quota", false],
    ["a 507", { status: 507 }, "quota", false],
    ["a 429", { status: 429 }, "rate_limit", true],
    ["a malformed answer to a read", { malformedResponse: true, status: 200 }, "transient", true],
    ["a read with no status", {}, "transient", true],
    ["a 500", { status: 500 }, "transient", true],
    ["a 499", { status: 499 }, "deterministic", false],
    ["a 400", { status: 400 }, "deterministic", false],
  ] as const)("%s", (_example, input, classification, retryable) => {
    expect(classifyProviderFailure(input)).toEqual(failure(classification, retryable));
  });

  it.each([
    ["a padded code with capitals", "  TikTok.Denied-1 ", "tiktok.denied-1"],
    ["a code of 100 characters", "a".repeat(100), "a".repeat(100)],
    ["a code of 101 characters", "a".repeat(101), "provider_deterministic"],
    ["a code with a space", "two words", "provider_deterministic"],
    ["a code that starts with a dot", ".hidden", "provider_deterministic"],
    ["a code outside ASCII", "défaut", "provider_deterministic"],
  ])("%s", (_example, code, normalized) => {
    expect(classifyProviderFailure({ code, status: 400 })).toEqual(
      failure("deterministic", false, normalized),
    );
  });

  it.each([
    ["a retry delay of zero", 0],
    ["a retry delay of one day", 86_400],
  ])("%s", (_example, retryAfterSeconds) => {
    expect(classifyProviderFailure({ retryAfterSeconds, status: 429 })).toEqual({
      ...failure("rate_limit", true),
      retryAfterSeconds,
    });
  });

  it.each([
    ["a negative retry delay", 429, -1, "rate_limit", true],
    ["a fractional retry delay", 429, 1.5, "rate_limit", true],
    ["a retry delay over one day", 429, 86_401, "rate_limit", true],
    ["a delay on a failure that is not retried", 400, 60, "deterministic", false],
  ] as const)("%s", (_example, status, retryAfterSeconds, classification, retryable) => {
    expect(classifyProviderFailure({ retryAfterSeconds, status })).toEqual(
      failure(classification, retryable),
    );
  });
});

describe("isUncertainFailure", () => {
  it.each([
    ["ambiguous", true],
    ["timeout", true],
    ["transient", true],
    ["auth", false],
    ["deterministic", false],
    ["quota", false],
    ["rate_limit", false],
  ] as const)("a %s failure", (classification, uncertain) => {
    expect(isUncertainFailure(failure(classification, false))).toEqual(uncertain);
  });
});

describe("normalizeProviderFailure", () => {
  it("a failure with a forged message and retry flag", () => {
    const forged = {
      classification: "auth",
      code: "Bad Code",
      message: "token=secret",
      retryable: true,
      retryAfterSeconds: 5,
    } as const;

    expect(normalizeProviderFailure(forged)).toEqual(failure("auth", false));
  });
});

describe("ambiguousFailure", () => {
  it("a code", () => {
    expect(ambiguousFailure("publish_unknown")).toEqual(
      failure("ambiguous", false, "publish_unknown"),
    );
  });
});

describe("rejection", () => {
  it.each([
    ["a default status", undefined, "deterministic", false],
    ["an explicit status", 429, "rate_limit", true],
  ] as const)("%s", (_example, status, classification, retryable) => {
    expect(rejection("reply_invalid", status)).toEqual(
      failure(classification, retryable, "reply_invalid"),
    );
  });
});

describe("rejected", () => {
  it("a code", () => {
    expect(rejected("reply_invalid").failure).toEqual(
      failure("deterministic", false, "reply_invalid"),
    );
  });
});

describe("malformed", () => {
  it.each([
    ["a read", false, "transient", true],
    ["a possible write", true, "ambiguous", false],
  ] as const)("%s", (_example, sideEffectPossible, classification, retryable) => {
    expect(malformed(sideEffectPossible).failure).toEqual(failure(classification, retryable));
  });
});

describe("isHttp404", () => {
  it.each([
    ["the provider 404 error", rejected("provider_http_404", 404), true],
    ["another provider error", rejected("provider_http_500", 500), false],
    ["a plain error with that message", new Error("provider_http_404"), false],
  ])("%s", (_example, cause, expected) => {
    expect(isHttp404(cause)).toEqual(expected);
  });
});

describe("failureDiagnostic", () => {
  it("an error with every detail", () => {
    const error = new ProviderAdapterError(
      classifyProviderFailure({ retryAfterSeconds: 30, status: 429 }),
      {
        missingScopes: ["video.publish"],
        request: { method: "POST", origin: "https://open.tiktokapis.com", status_code: 429 },
      },
    );

    expect(failureDiagnostic(error)).toEqual({
      classification: "rate_limit",
      code: "provider_rate_limit",
      retryable: true,
      retryAfterSeconds: 30,
      request: { method: "POST", origin: "https://open.tiktokapis.com", status_code: 429 },
      missing_scopes: ["video.publish"],
    });
  });

  it("an error with no detail", () => {
    expect(failureDiagnostic(rejected("reply_invalid"))).toEqual({
      classification: "deterministic",
      code: "reply_invalid",
      retryable: false,
    });
  });
});

describe("ProviderAdapterError", () => {
  it("a failure carrying a forged message and code", () => {
    const cause = new Error("root");
    const forged = {
      classification: "auth",
      code: "Bearer secret",
      message: "access_token=secret",
      retryable: true,
    } as const;

    const error = new ProviderAdapterError(forged, { cause });

    expect({
      cause: error.cause,
      failure: error.failure,
      message: error.message,
      name: error.name,
    }).toEqual({
      cause,
      failure: failure("auth", false),
      message: "The provider authorization must be refreshed.",
      name: "ProviderAdapterError",
    });
  });
});
