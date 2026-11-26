import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import {
  analyticsFormatParam,
  analyticsMetricParam,
  ASSET_STATUS_VALUES,
  booleanParam,
  brandProfileColorField,
  brandProfileDescriptionField,
  brandProfileNameField,
  completedPartsField,
  dateField,
  dateRange,
  enumParam,
  integerParam,
  onlyKeys,
  optionalDateParam,
  optionalStringField,
  partNumbersField,
  platformParam,
  POST_STATUS_VALUES,
  positiveIntegerField,
  postTextField,
  postTitleField,
  REPLY_STATUS_VALUES,
  stringArrayField,
  stringField,
  textParam,
  uuidArrayField,
  uuidParam,
  validateDateSpan,
  workspaceNameValue,
} from "../src/validation";

const UUID_1 = "00000000-0000-4000-8000-000000000001";
const UUID_2 = "00000000-0000-4000-8000-000000000002";

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("enumParam and platformParam", () => {
  it.each([
    ["asset status", "ready", "status", ASSET_STATUS_VALUES, "ready"],
    ["post status", "draft", "status", POST_STATUS_VALUES, "draft"],
    ["reply status", "replied", "reply_status", REPLY_STATUS_VALUES, "replied"],
    ["undefined", undefined, "status", ASSET_STATUS_VALUES, undefined],
    ["empty string", "", "status", ASSET_STATUS_VALUES, undefined],
  ])("accepts %s", (_example, value, name, allowed, expected) => {
    expect(enumParam(value, name, allowed as ReadonlySet<string>)).toEqual(expected);
  });

  it("rejects values outside the enum set", () => {
    expect(thrownBy(() => enumParam("unknown", "status", ASSET_STATUS_VALUES))).toEqual(
      new CoreApiError(400, "invalid_request", "status is invalid."),
    );
  });

  it("accepts a canonical platform", () => {
    expect(platformParam("tiktok")).toEqual("tiktok");
  });

  it("rejects an unsupported platform", () => {
    expect(thrownBy(() => platformParam("unknown"))).toEqual(
      new CoreApiError(400, "invalid_request", "The platform is not supported."),
    );
  });
});

describe("analyticsMetricParam and analyticsFormatParam", () => {
  it.each([
    ["omitted metric defaults to views", undefined, "views"],
    ["empty metric defaults to views", "", "views"],
    ["explicit likes metric", "likes", "likes"],
  ])("%s", (_example, value, expected) => {
    expect(analyticsMetricParam(value)).toEqual(expected);
  });

  it.each(["unknown", "toString", "constructor"])("rejects invalid metric %s", (value) => {
    expect(thrownBy(() => analyticsMetricParam(value))).toEqual(
      new CoreApiError(400, "invalid_request", "metric is invalid."),
    );
  });

  it.each([
    ["omitted format", undefined, undefined],
    ["empty format", "", undefined],
    ["video format", "video", "video"],
  ])("%s", (_example, value, expected) => {
    expect(analyticsFormatParam(value)).toEqual(expected);
  });

  it.each(["unknown", "toString"])("rejects invalid format %s", (value) => {
    expect(thrownBy(() => analyticsFormatParam(value))).toEqual(
      new CoreApiError(400, "invalid_request", "format is invalid."),
    );
  });
});

describe("textParam, uuidParam, integerParam, booleanParam", () => {
  it.each([
    ["trimmed value", "  member.role_changed  ", "member.role_changed"],
    ["blank string", "   ", undefined],
    ["undefined", undefined, undefined],
  ])("textParam %s", (_example, value, expected) => {
    expect(textParam(value, "action", 100)).toEqual(expected);
  });

  it.each([
    ["over length ceiling", "a".repeat(101)],
    ["newline control char", "member\nrole"],
    ["null control char", "member\u0000role"],
  ])("textParam rejects %s", (_example, value) => {
    expect(thrownBy(() => textParam(value, "q", 100))).toEqual(
      new CoreApiError(
        400,
        "invalid_request",
        "q must contain at most 100 non-control characters.",
      ),
    );
  });

  it("uuidParam accepts a valid UUID and rejects malformed input", () => {
    expect(uuidParam(UUID_1, "id")).toEqual(UUID_1);
    expect(thrownBy(() => uuidParam("not-a-uuid", "id"))).toEqual(
      new CoreApiError(400, "invalid_request", "id must be a valid UUID."),
    );
  });

  it.each([
    ["undefined falls back", undefined, 10],
    ["empty falls back", "", 10],
    ["minimum bound", "1", 1],
    ["maximum bound", "50", 50],
  ])("integerParam %s", (_example, value, expected) => {
    expect(integerParam(value, "limit", 10, 1, 50)).toEqual(expected);
  });

  it.each([
    ["non-integer", "1.5", "limit must be an integer."],
    ["below minimum", "0", "limit must be between 1 and 50."],
    ["above maximum", "51", "limit must be between 1 and 50."],
  ])("integerParam rejects %s", (_example, value, message) => {
    expect(thrownBy(() => integerParam(value, "limit", 10, 1, 50))).toEqual(
      new CoreApiError(400, "invalid_request", message),
    );
  });

  it.each([
    ["undefined", undefined, undefined],
    ["empty", "", undefined],
    ["true", "true", true],
    ["false", "false", false],
  ])("booleanParam %s", (_example, value, expected) => {
    expect(booleanParam(value, "active")).toEqual(expected);
  });

  it("booleanParam rejects non-boolean text", () => {
    expect(thrownBy(() => booleanParam("yes", "active"))).toEqual(
      new CoreApiError(400, "invalid_request", "active must be true or false."),
    );
  });
});

describe("dateField, optionalDateParam, dateRange, validateDateSpan", () => {
  it("parses RFC3339 timestamps", () => {
    const iso = "2026-01-15T10:30:00Z";
    expect(dateField({ scheduled_at: iso }, "scheduled_at")).toEqual(new Date(iso));
    expect(optionalDateParam(iso, "since")).toEqual(new Date(iso));
    expect(optionalDateParam(undefined, "since")).toEqual(undefined);
  });

  it.each([
    ["non-string", { scheduled_at: 123 }],
    ["non-RFC3339 format", { scheduled_at: "2026-01-15" }],
    ["impossible month", { scheduled_at: "2026-99-01T00:00:00Z" }],
  ])("dateField rejects %s", (_example, body) => {
    expect(thrownBy(() => dateField(body, "scheduled_at"))).toEqual(
      new CoreApiError(400, "validation_error", "scheduled_at must be an RFC3339 timestamp."),
    );
  });

  it("accepts a range up to maximumDays", () => {
    expect(dateRange("2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z", 7)).toEqual({
      end: new Date("2026-01-08T00:00:00Z"),
      start: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("rejects a reversed range", () => {
    expect(
      thrownBy(() =>
        validateDateSpan(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z"), 7),
      ),
    ).toEqual(new CoreApiError(400, "invalid_range", "end must be at or after start."));
  });

  it("rejects a range exceeding maximumDays", () => {
    expect(
      thrownBy(() =>
        validateDateSpan(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-09T00:00:00Z"), 7),
      ),
    ).toEqual(new CoreApiError(400, "invalid_range", "The requested range cannot exceed 7 days."));
  });
});

describe("body field validators", () => {
  it("onlyKeys rejects unknown keys", () => {
    expect(onlyKeys({ a: 1 }, ["a", "b"])).toEqual(undefined);
    expect(thrownBy(() => onlyKeys({ a: 1, extra: true }, ["a"]))).toEqual(
      new CoreApiError(400, "validation_error", "The request contains an unknown field."),
    );
  });

  it("uuidArrayField accepts unique UUIDs, null, undefined and rejects repeats or bad entries", () => {
    expect(uuidArrayField({}, "asset_ids")).toEqual(undefined);
    expect(uuidArrayField({ asset_ids: null }, "asset_ids")).toEqual(null);
    expect(uuidArrayField({ asset_ids: [UUID_1, UUID_2] }, "asset_ids")).toEqual([UUID_1, UUID_2]);
    expect(thrownBy(() => uuidArrayField({ asset_ids: [UUID_1, UUID_1] }, "asset_ids"))).toEqual(
      new CoreApiError(400, "validation_error", "asset_ids must not repeat an asset."),
    );
    expect(thrownBy(() => uuidArrayField({ asset_ids: ["bad"] }, "asset_ids"))).toEqual(
      new CoreApiError(400, "validation_error", "asset_ids must be an array of valid UUIDs."),
    );
  });

  it("postTitleField and postTextField validate bounds and control characters", () => {
    expect(postTitleField({ title: "  Launch  " }, "title")).toEqual("Launch");
    expect(thrownBy(() => postTitleField({ title: "a".repeat(201) }, "title"))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "title must be a string of at most 200 characters.",
      ),
    );
    expect(postTextField({ text: "Line 1\nLine 2" }, "text")).toEqual("Line 1\nLine 2");
    expect(thrownBy(() => postTextField({ text: "bad\u0000text" }, "text"))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "text must be a string of at most 10000 characters.",
      ),
    );
  });

  it("brandProfile and workspace name validators enforce allowed formats", () => {
    expect(brandProfileNameField({ name: "Brand" }, "name")).toEqual("Brand");
    expect(thrownBy(() => brandProfileNameField({ name: "   " }, "name"))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "name must contain 1 to 100 non-control characters and cannot be blank.",
      ),
    );
    expect(brandProfileDescriptionField({ description: null }, "description")).toEqual(null);
    expect(brandProfileDescriptionField({ description: "Short bio" }, "description")).toEqual(
      "Short bio",
    );
    expect(brandProfileColorField({ color: "#b91c1c" }, "color")).toEqual("#b91c1c");
    expect(thrownBy(() => brandProfileColorField({ color: "#ffffff" }, "color"))).toEqual(
      new CoreApiError(400, "validation_error", "color is invalid."),
    );
    expect(workspaceNameValue("  Acme  ", "name")).toEqual("Acme");
    expect(thrownBy(() => workspaceNameValue(" ", "name"))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "name must contain 1 to 200 characters without control characters.",
      ),
    );
  });

  it("scalar and multipart field validators enforce types and ranges", () => {
    expect(stringField({ a: "ok" }, "a")).toEqual("ok");
    expect(optionalStringField({ a: null }, "a")).toEqual(null);
    expect(stringArrayField({ tags: ["a"] }, "tags")).toEqual(["a"]);
    expect(positiveIntegerField({ file_size: 42 }, "file_size")).toEqual(42);
    expect(thrownBy(() => positiveIntegerField({ file_size: 0 }, "file_size"))).toEqual(
      new CoreApiError(400, "validation_error", "file_size must be a positive safe integer."),
    );
    expect(partNumbersField({ part_numbers: [1, 10_000] })).toEqual([1, 10_000]);
    expect(thrownBy(() => partNumbersField({ part_numbers: [0] }))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "part_numbers must be an array of integers between 1 and 10000.",
      ),
    );
    expect(completedPartsField({ parts: [{ etag: "e1", part_number: 1 }] })).toEqual([
      { etag: "e1", part_number: 1 },
    ]);
    expect(thrownBy(() => completedPartsField({ parts: [{ etag: 1, part_number: 1 }] }))).toEqual(
      new CoreApiError(
        400,
        "validation_error",
        "Every completed part requires an integer part_number and string etag.",
      ),
    );
  });
});
