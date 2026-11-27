import { describe, expect, it } from "vite-plus/test";

import { requiredIdentifier, validatePageInput, validateSnapshotPage } from "../src/failures";

import {
  assertHttpsOrLoopbackUrl,
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  exactRedirectUri,
  firstNonEmptyLine,
  jsonHeaders,
  mediaKind,
  metricValue,
  normalizeContentType,
  numericOrStringIdentifier,
  optionalSecureUrl,
  providerIdentifier,
  record,
  required,
  requireIdempotencyKey,
  secureUrl,
  timestamp,
  validFileSize,
} from "../src/values";
import { failureThrownBy, refused, thrownBy } from "./support";

describe("firstNonEmptyLine", () => {
  it.each([
    ["a title after blank lines", "  \r\n\n  First title \r\nSecond line", "First title"],
    ["only whitespace", "   \n\t  ", undefined],
    ["an empty string", "", undefined],
  ])("%s", (_example, text, line) => {
    expect(firstNonEmptyLine(text)).toEqual(line);
  });
});

describe("normalizeContentType", () => {
  it.each([
    ["capitals and parameters", "Video/MP4; codecs=avc1", "video/mp4"],
    ["padding without parameters", " image/png ", "image/png"],
    ["an empty string", "", ""],
  ])("%s", (_example, contentType, normalized) => {
    expect(normalizeContentType(contentType)).toEqual(normalized);
  });
});

describe("mediaKind", () => {
  it.each([
    ["an image type", "IMAGE/PNG", "image"],
    ["a video type", "video/mp4; codecs=avc1", "video"],
    ["another type", "text/plain", null],
  ])("%s", (_example, contentType, kind) => {
    expect(mediaKind(contentType)).toEqual(kind);
  });
});

describe("validFileSize", () => {
  it.each([
    ["one byte", 1, true],
    ["the maximum", 10, true],
    ["one over the maximum", 11, false],
    ["zero", 0, false],
    ["a fraction", 1.5, false],
  ])("%s", (_example, fileSize, valid) => {
    expect(validFileSize(fileSize, 10)).toEqual(valid);
  });
});

describe("required", () => {
  it.each([
    ["padded text", "  value  ", "value"],
    ["text of the maximum length", "abcde", "abcde"],
  ])("%s", (_example, value, expected) => {
    expect(required("field", value, 5)).toEqual(expected);
  });

  it.each([
    ["blank text", "   "],
    ["text over the maximum", "abcdef"],
    ["a control character", "a\u0000b"],
  ])("%s", (_example, value) => {
    expect(thrownBy(() => required("field", value, 5))).toEqual(new TypeError("field is invalid"));
  });
});

describe("assertHttpsOrLoopbackUrl", () => {
  it.each([
    ["an https URL", "https://a.test/x", "https://a.test/x"],
    ["http on localhost", "http://localhost:3000/x", "http://localhost:3000/x"],
    ["http on the loopback address", "http://127.0.0.1/x", "http://127.0.0.1/x"],
  ])("%s", (_example, value, href) => {
    expect(assertHttpsOrLoopbackUrl(value).href).toEqual(href);
  });

  it.each([
    ["http on a remote host", "http://a.test"],
    ["another loopback protocol", "ftp://localhost"],
    ["a username", "https://u@a.test"],
    ["a password", "https://:p@a.test"],
    ["a fragment", "https://a.test/#x"],
  ])("%s", (_example, value) => {
    expect(thrownBy(() => assertHttpsOrLoopbackUrl(value, "callback"))).toEqual(
      new TypeError("callback must be HTTPS or an exact loopback HTTP URL"),
    );
  });
});

describe("exactRedirectUri", () => {
  it("a padded https URI", () => {
    expect(exactRedirectUri("  https://a.test  ")).toEqual("https://a.test/");
  });

  it("a blank URI", () => {
    expect(thrownBy(() => exactRedirectUri(" "))).toEqual(new TypeError("redirectUri is invalid"));
  });
});

describe("providerIdentifier", () => {
  it.each([
    ["a padded identifier", " a.b_c:d-1 ", "a.b_c:d-1"],
    ["255 characters", "a".repeat(255), "a".repeat(255)],
    ["256 characters", "a".repeat(256), undefined],
    ["a leading dot", ".a", undefined],
    ["a slash", "a/b", undefined],
    ["a number", 7, undefined],
  ])("%s", (_example, value, identifier) => {
    expect(providerIdentifier(value)).toEqual(identifier);
  });
});

describe("requiredIdentifier", () => {
  it("a valid identifier", () => {
    expect(requiredIdentifier("abc", "post_id_invalid")).toEqual("abc");
  });

  it("an invalid identifier", () => {
    expect(failureThrownBy(() => requiredIdentifier("", "post_id_invalid"))).toEqual(
      refused("post_id_invalid"),
    );
  });
});

describe("numericOrStringIdentifier", () => {
  it.each([
    ["a string", "17841400000000000", "17841400000000000"],
    ["a safe integer", 42, "42"],
    ["zero", 0, undefined],
    ["a negative number", -1, undefined],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1, undefined],
  ])("%s", (_example, value, identifier) => {
    expect(numericOrStringIdentifier(value)).toEqual(identifier);
  });
});

describe("boundedString", () => {
  it.each([
    ["a padded string at the maximum", " abc ", "abc"],
    ["a string over the maximum", "abcd", undefined],
    ["a blank string", "  ", undefined],
    ["a number", 3, undefined],
  ])("%s", (_example, value, bounded) => {
    expect(boundedString(value, 3)).toEqual(bounded);
  });
});

describe("boundedText", () => {
  it.each([
    ["text with surrounding spaces", " a ", false, " a "],
    ["text over the maximum", "abcd", false, undefined],
    ["an empty string", "", false, undefined],
    ["an allowed empty string", "", true, ""],
    ["a number", 3, true, undefined],
  ])("%s", (_example, value, allowEmpty, bounded) => {
    expect(boundedText(value, 3, allowEmpty)).toEqual(bounded);
  });
});

describe("boundedCursor", () => {
  it.each([
    ["one character", "a", "a"],
    ["2048 characters", "a".repeat(2_048), "a".repeat(2_048)],
    ["2049 characters", "a".repeat(2_049), undefined],
    ["an empty string", "", undefined],
    ["a control character", "a\n", undefined],
    ["a number", 1, undefined],
  ])("%s", (_example, value, cursor) => {
    expect(boundedCursor(value)).toEqual(cursor);
  });
});

describe("validatePageInput", () => {
  it.each([
    ["the smallest page", { limit: 1 }],
    ["the largest page with a cursor", { limit: 100, cursor: "next" }],
  ])("%s", (_example, input) => {
    expect(() => validatePageInput("tiktok", input)).not.toThrow();
  });

  it.each([
    ["a limit of zero", { limit: 0 }],
    ["a limit of 101", { limit: 101 }],
    ["a fractional limit", { limit: 1.5 }],
    ["an empty cursor", { limit: 1, cursor: "" }],
  ])("%s", (_example, input) => {
    expect(failureThrownBy(() => validatePageInput("tiktok", input))).toEqual(
      refused("tiktok_page_invalid"),
    );
  });
});

describe("validateSnapshotPage", () => {
  it("a first page", () => {
    expect(() => validateSnapshotPage("youtube", { limit: 1 })).not.toThrow();
  });

  it("a cursor", () => {
    expect(
      failureThrownBy(() => validateSnapshotPage("youtube", { limit: 1, cursor: "next" })),
    ).toEqual(refused("youtube_analytics_not_paginated"));
  });
});

describe("timestamp", () => {
  it.each([
    ["an offset timestamp", "2026-01-02T10:04:05+07:00", "2026-01-02T03:04:05.000Z"],
    ["an unparseable string", "yesterday", undefined],
    ["65 characters", "2".repeat(65), undefined],
    ["a number", 1_700_000_000, undefined],
  ])("%s", (_example, value, expected) => {
    expect(timestamp(value)).toEqual(expected);
  });
});

describe("requireIdempotencyKey", () => {
  it("a key of 255 characters", () => {
    expect(() => requireIdempotencyKey("k".repeat(255))).not.toThrow();
  });

  it("a key of 256 characters", () => {
    expect(thrownBy(() => requireIdempotencyKey("k".repeat(256)))).toEqual(
      new TypeError("idempotencyKey is invalid"),
    );
  });
});

describe("secureUrl", () => {
  it("an https URL", () => {
    expect(secureUrl("https://a.test/x")?.href).toEqual("https://a.test/x");
  });

  it.each([
    ["an http URL", "http://a.test"],
    ["a username", "https://u@a.test"],
    ["a password", "https://:p@a.test"],
    ["a fragment", "https://a.test/#x"],
    ["an unparseable string", "not a url"],
    ["a number", 1],
  ])("%s", (_example, value) => {
    expect(secureUrl(value)).toEqual(undefined);
  });
});

describe("optionalSecureUrl", () => {
  it.each([
    ["no value", undefined, { valid: true }],
    ["a secure URL", "https://a.test", { valid: true, href: "https://a.test/" }],
    ["an insecure URL", "http://a.test", { valid: false }],
  ])("%s", (_example, value, expected) => {
    expect(optionalSecureUrl(value)).toEqual(expected);
  });
});

describe("record", () => {
  it.each([
    ["an object", { a: 1 }, { a: 1 }],
    ["an array", [1], undefined],
    ["a null value", null, undefined],
    ["a string", "a", undefined],
  ])("%s", (_example, value, expected) => {
    expect(record(value)).toEqual(expected);
  });
});

describe("bearer", () => {
  it("a padded token", () => {
    expect(bearer(" token ")).toEqual({ Authorization: "Bearer token" });
  });

  it("a blank token", () => {
    expect(thrownBy(() => bearer(" "))).toEqual(new TypeError("accessToken is invalid"));
  });
});

describe("jsonHeaders", () => {
  it("a token", () => {
    expect(jsonHeaders("token")).toEqual({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
  });
});

describe("metricValue", () => {
  it.each([
    ["zero", 0, 0],
    ["a negative number", -1, undefined],
    ["a fraction", 1.5, undefined],
    ["a numeric string", "3", undefined],
  ])("%s", (_example, value, expected) => {
    expect(metricValue(value)).toEqual(expected);
  });
});
