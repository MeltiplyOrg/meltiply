import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  captionWithSignature,
  defaultSignatureTemplate,
  instantToWallClock,
  resolveSignature,
  wallClockToInstant,
} from "./publishing-preferences";

const template = {
  body: "Follow {brand_profile} on {platform} at {channel}.",
  id: "00000000-0000-4000-8000-000000000901",
  is_default: true,
  name: "Footer",
  position: 0,
};

beforeAll(() => {
  wallClockToInstant("2026-01-01T00:00", "America/New_York");
  instantToWallClock("2026-01-01T00:00:00Z", "Asia/Tokyo");
});

describe("resolveSignature", () => {
  const target = {
    brandProfileName: " Alpha Studio ",
    channelName: "@alpha",
    platform: "instagram",
  };

  it.each([
    [
      "every placeholder",
      "Follow {brand_profile} on {platform} at {channel}.",
      "Follow Alpha Studio on Instagram at @alpha.",
    ],
    ["a placeholder used twice", "{channel} {channel}", "@alpha @alpha"],
    ["an unknown placeholder", "{handle} {channel}", "{handle} @alpha"],
    ["an empty body", "", ""],
  ])("%s", (_example, body, signature) => {
    expect(resolveSignature(body, target)).toEqual(signature);
  });
});

describe("captionWithSignature", () => {
  it.each([
    ["content and a signature", " Launch ", " Footer ", "Launch\n\nFooter"],
    ["no signature", "Launch", undefined, "Launch"],
    ["a null signature", "Launch", null, "Launch"],
    ["a blank signature", "Launch", "  ", "Launch"],
    ["a signature without content", "  ", "Footer", "Footer"],
    ["neither", "", null, ""],
  ])("%s", (_example, content, signature, caption) => {
    expect(captionWithSignature(content, signature)).toEqual(caption);
  });
});

describe("defaultSignatureTemplate", () => {
  it("a list with a default", () => {
    const templates = [{ ...template, id: "other", is_default: false }, template];

    expect(defaultSignatureTemplate(templates)).toEqual(template);
  });

  it.each([
    ["a list without a default", [{ ...template, is_default: false }]],
    ["an empty list", []],
  ])("%s", (_example, templates) => {
    expect(defaultSignatureTemplate(templates)).toEqual(null);
  });
});

describe("wallClockToInstant", () => {
  it.each([
    ["an ordinary time", "2026-01-02T00:45", "Asia/Tokyo", "2026-01-01T15:45:00.000Z"],
    [
      "a time in the spring-forward gap",
      "2026-03-08T02:30",
      "America/New_York",
      "2026-03-08T07:30:00.000Z",
    ],
    [
      "a time that happens twice",
      "2026-11-01T01:30",
      "America/New_York",
      "2026-11-01T05:30:00.000Z",
    ],
    ["text that is not a time", "not-a-time", "UTC", null],
    ["a time with seconds", "2026-01-02T00:45:00", "UTC", null],
    ["a date that does not exist", "2026-13-40T99:99", "UTC", null],
    ["an unknown zone", "2026-01-02T00:45", "Mars/Olympus", null],
  ])("%s", (_example, value, timeZone, instant) => {
    expect(wallClockToInstant(value, timeZone)).toEqual(instant);
  });
});

describe("instantToWallClock", () => {
  it.each([
    ["an instant ahead of UTC", "2026-01-01T15:45:00.000Z", "Asia/Tokyo", "2026-01-02T00:45"],
    ["a minute after midnight", "2026-07-04T04:01:00.000Z", "America/New_York", "2026-07-04T00:01"],
    ["exactly midnight", "2026-07-04T04:00:00.000Z", "America/New_York", "2026-07-04T10:00"],
    ["text that is not an instant", "yesterday", "UTC", ""],
  ])("%s", (_example, instant, timeZone, wallClock) => {
    expect(instantToWallClock(instant, timeZone)).toEqual(wallClock);
  });

  it("midnight with no daytime default", () => {
    const instant = new Date("2026-07-04T04:00:00.000Z");

    expect(instantToWallClock(instant, "America/New_York", false)).toEqual("2026-07-04T00:00");
  });
});
