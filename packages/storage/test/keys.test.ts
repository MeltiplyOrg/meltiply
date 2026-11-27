import { describe, expect, it } from "vite-plus/test";

import { normalizeSegment, readyObjectKey, stagingObjectKey } from "../src/keys";

describe("normalizeSegment", () => {
  it.each([
    ["a padded segment", "  clip.mp4 ", "clip.mp4"],
    ["a segment outside ASCII", "café 🚀.png", "café 🚀.png"],
  ])("%s", (_example, value, segment) => {
    expect(normalizeSegment("name", value)).toEqual(segment);
  });

  it.each([
    ["an empty segment", ""],
    ["a blank segment", "  "],
    ["a single dot", "."],
    ["two dots", ".."],
    ["a parent path", "../escape"],
    ["a slash", "nested/name"],
    ["a backslash", "nested\\name"],
    ["a tab", "tab\tname"],
    ["a delete character", "a\u007fb"],
  ])("%s", (_example, value) => {
    expect(() => normalizeSegment("name", value)).toThrow(
      new TypeError("name must be a non-empty path segment"),
    );
  });
});

describe("stagingObjectKey", () => {
  it("an upload", () => {
    expect(stagingObjectKey("org-alpha", "asset-one", "session-one", "clip.mp4")).toEqual(
      "staging/org-alpha/asset-one/session-one/clip.mp4",
    );
  });

  it.each<[string, Parameters<typeof stagingObjectKey>]>([
    ["organizationId", ["..", "a", "s", "f"]],
    ["assetId", ["o", "..", "s", "f"]],
    ["sessionId", ["o", "a", "..", "f"]],
    ["filename", ["o", "a", "s", ".."]],
  ])("an unsafe %s", (name, parts) => {
    expect(() => stagingObjectKey(...parts)).toThrow(
      new TypeError(`${name} must be a non-empty path segment`),
    );
  });
});

describe("readyObjectKey", () => {
  it("a rendition", () => {
    expect(readyObjectKey("org-alpha", "asset-one", "rendition-webp")).toEqual(
      "org-alpha/asset-one/rendition-webp",
    );
  });

  it.each<[string, Parameters<typeof readyObjectKey>]>([
    ["organizationId", ["..", "a", "n"]],
    ["assetId", ["o", "..", "n"]],
    ["name", ["o", "a", ".."]],
  ])("an unsafe %s", (name, parts) => {
    expect(() => readyObjectKey(...parts)).toThrow(
      new TypeError(`${name} must be a non-empty path segment`),
    );
  });
});
