import { describe, expect, it } from "vite-plus/test";

import { errorDiagnostic, sanitizeRecord } from "../src/sanitize";

function failure(name: string, message: string, stack?: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = name;
  error.stack = stack;
  return error;
}

function unreadable(property: string, target: object = {}) {
  return Object.defineProperty(target, property, {
    enumerable: true,
    get() {
      throw new Error("unreadable");
    },
  });
}

const nest = (depth: number): Record<string, unknown> =>
  depth === 0 ? { leaf: "value" } : { child: nest(depth - 1) };

describe("sanitizeRecord", () => {
  it("an empty record", () => {
    expect(sanitizeRecord({})).toEqual({});
  });

  it("every sensitive key", () => {
    const record = {
      authorization: "a",
      cookie: "b",
      email: "c",
      password: "d",
      client_secret: "e",
      signedUrl: "f",
      access_token: "g",
      upload_url: "h",
      safe: "visible",
    };

    expect(sanitizeRecord(record)).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      email: "[REDACTED]",
      password: "[REDACTED]",
      client_secret: "[REDACTED]",
      signedUrl: "[REDACTED]",
      access_token: "[REDACTED]",
      upload_url: "[REDACTED]",
      safe: "visible",
    });
  });

  it.each([
    ["a plain URL", "https://a.test/x", "https://a.test/x"],
    ["a signed URL", "https://a.test/x?X-Amz-Signature=s", "https://a.test/x?[REDACTED]"],
    ["a URL with a fragment", "https://a.test/x#s", "https://a.test/x?[REDACTED]"],
    ["a URL with credentials", "https://u:p@a.test/x", "https://a.test/x"],
    ["a URL that cannot be parsed", "see http://[bad", "see [REDACTED URL]"],
    ["a bearer credential", "sent Bearer abc.def", "sent Bearer [REDACTED]"],
    ["an OAuth code", "code=abc state: xyz", "code=[REDACTED] state=[REDACTED]"],
    ["a quoted JSON secret", '{"client_secret": "x y"}', '{"client_secret=[REDACTED]}'],
    ["text already redacted", "token=[REDACTED]", "token=[REDACTED]"],
    ["text outside ASCII", "café 🚀", "café 🚀"],
    ["a string of 2048 characters", "a".repeat(2048), "a".repeat(2048)],
    ["a string of 2049 characters", "a".repeat(2049), `${"a".repeat(2048)}…`],
  ])("%s", (_example, value, sanitized) => {
    expect(sanitizeRecord({ value })).toEqual({ value: sanitized });
  });

  it.each([
    ["a null value", null, null],
    ["no value", undefined, undefined],
    ["a number", 0, 0],
    ["a boolean", false, false],
    ["a big integer", 12n, "12"],
    ["a function", function named() {}, "[Function named]"],
    ["an anonymous function", () => {}, "[Function anonymous]"],
    ["a symbol", Symbol("s"), "[Symbol]"],
    ["a date", new Date("2026-01-02T03:04:05Z"), "2026-01-02T03:04:05.000Z"],
    ["an invalid date", new Date("no"), "[Invalid Date]"],
  ])("%s", (_example, value, sanitized) => {
    expect(sanitizeRecord({ value })).toEqual({ value: sanitized });
  });

  it("a list of 51 items", () => {
    const value = Array.from({ length: 51 }, () => 1);

    expect(sanitizeRecord({ value })).toEqual({
      value: [...Array.from({ length: 50 }, () => 1), "[+1 items]"],
    });
  });

  it("a record of 51 keys", () => {
    const record = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 1]));

    expect(sanitizeRecord(record)).toEqual({
      ...Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, 1])),
      "…": "additional keys truncated",
    });
  });

  it("a record nested past the depth limit", () => {
    expect(sanitizeRecord(nest(7))).toEqual({
      child: { child: { child: { child: { child: { child: "[Truncated]" } } } } },
    });
  });

  it("a record that contains itself", () => {
    const record: Record<string, unknown> = { safe: "ok" };
    record.self = record;

    expect(sanitizeRecord(record)).toEqual({ safe: "ok", self: "[Circular]" });
  });

  it("the same object twice", () => {
    const shared = { a: 1 };

    expect(sanitizeRecord({ one: shared, two: shared })).toEqual({ one: { a: 1 }, two: { a: 1 } });
  });

  it("an unreadable property", () => {
    expect(sanitizeRecord(unreadable("value") as Record<string, unknown>)).toEqual({
      value: "[Unreadable]",
    });
  });

  it("an error value", () => {
    expect(sanitizeRecord({ value: failure("TypeError", "boom") })).toEqual({
      value: { message: "boom", name: "TypeError" },
    });
  });
});

describe("errorDiagnostic", () => {
  it("an error with a stack", () => {
    const error = failure("TypeError", "boom", "TypeError: boom\n    at run");

    expect(errorDiagnostic(error)).toEqual({
      error: {
        fingerprint: "fc8529cc622ce842",
        message: "boom",
        name: "TypeError",
        stack: "TypeError: boom\n    at run",
      },
    });
  });

  it("a message and stack carrying a credential", () => {
    const error = failure("Error", "token=secret-value", "at https://a.test/?code=c");

    expect(errorDiagnostic(error)).toEqual({
      error: {
        fingerprint: "3dd438d76f233c61",
        message: "token=[REDACTED]",
        name: "Error",
        stack: "at https://a.test/?[REDACTED]",
      },
    });
  });

  it("a name that is not an identifier", () => {
    expect(errorDiagnostic(failure("bad name!", "boom"))).toEqual({
      error: { fingerprint: "e3ac4cc44d699f3a", message: "boom", name: "Error" },
    });
  });

  it("a message of 513 characters", () => {
    expect(errorDiagnostic(failure("Error", "a".repeat(513)))).toEqual({
      error: { fingerprint: "ce592e26d6a0188c", message: `${"a".repeat(512)}…`, name: "Error" },
    });
  });

  it("a stack of 4097 characters", () => {
    expect(errorDiagnostic(failure("TypeError", "boom", "s".repeat(4097)))).toEqual({
      error: {
        fingerprint: "fc8529cc622ce842",
        message: "boom",
        name: "TypeError",
        stack: `${"s".repeat(4096)}…`,
      },
    });
  });

  it("an error with a cause", () => {
    const error = failure("Error", "outer", undefined, failure("TypeError", "inner"));

    expect(errorDiagnostic(error)).toEqual({
      error: {
        cause: { message: "inner", name: "TypeError" },
        fingerprint: "400e2b06270f8be4",
        message: "outer",
        name: "Error",
      },
    });
  });

  it("an error that causes itself", () => {
    const inner = failure("TypeError", "inner");
    const error = failure("Error", "outer", undefined, inner);
    Object.defineProperty(inner, "cause", { value: error });

    expect(errorDiagnostic(error).error.cause).toEqual({
      cause: { message: "[circular cause reference]", name: "CircularCause" },
      message: "inner",
      name: "TypeError",
    });
  });

  it("a cause chain past four levels", () => {
    let error = failure("Error", "level", undefined, { marker: "deep-private-detail" });
    for (let index = 0; index < 4; index++) error = failure("Error", "level", undefined, error);

    expect(errorDiagnostic(error).error.cause).toEqual({
      cause: {
        cause: {
          cause: { message: "[cause chain truncated]", name: "TruncatedCause" },
          message: "level",
          name: "Error",
        },
        message: "level",
        name: "Error",
      },
      message: "level",
      name: "Error",
    });
  });

  it("an unreadable stack", () => {
    const error = unreadable("stack", failure("TypeError", "boom")) as Error;

    expect(errorDiagnostic(error)).toEqual({
      error: { fingerprint: "fc8529cc622ce842", message: "boom", name: "TypeError" },
    });
  });

  it("an unreadable cause", () => {
    const error = unreadable("cause", failure("TypeError", "boom")) as Error;

    expect(errorDiagnostic(error)).toEqual({
      error: {
        cause: "[unreadable cause]",
        fingerprint: "fc8529cc622ce842",
        message: "boom",
        name: "TypeError",
      },
    });
  });

  it.each([
    ["a carried fingerprint", "0123456789abcdef", "0123456789abcdef"],
    ["a malformed carried fingerprint", "nope", "dcf2f0eb09f42ad9"],
  ])("a serialized error with %s", (_example, carried, fingerprint) => {
    const cause = { name: "Err", message: "m", fingerprint: carried };

    expect(errorDiagnostic(cause)).toEqual({ error: { fingerprint, message: "m", name: "Err" } });
  });

  it.each([
    ["a thrown string", "plain string", "UnknownError", "plain string", "18f14dc6cb6981ec"],
    ["a thrown null", null, "UnknownError", "null", "69b13c2a04541d20"],
    [
      "a thrown tagged object",
      { _tag: "ProviderError", token: "private", responseBody: "private" },
      "ProviderError",
      "[non-Error thrown object ProviderError]",
      "5cd9a028664eb5d2",
    ],
    ["a thrown plain object", {}, "UnknownError", "[non-Error thrown object]", "72f037403d47b29e"],
  ])("%s", (_example, cause, name, message, fingerprint) => {
    expect(errorDiagnostic(cause)).toEqual({ error: { fingerprint, message, name } });
  });
});
