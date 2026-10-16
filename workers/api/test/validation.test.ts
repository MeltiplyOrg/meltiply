import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import {
  ASSET_STATUS_VALUES,
  POST_STATUS_VALUES,
  enumParam,
  platformParam,
  REPLY_STATUS_VALUES,
} from "../src/validation";

describe("request enum validation", () => {
  it("accepts values from each route enum set", () => {
    expect(enumParam("ready", "status", ASSET_STATUS_VALUES)).toBe("ready");
    expect(enumParam("draft", "status", POST_STATUS_VALUES)).toBe("draft");
    expect(enumParam("replied", "reply_status", REPLY_STATUS_VALUES)).toBe("replied");
  });

  it("treats missing and empty query values as absent", () => {
    expect(enumParam(undefined, "status", ASSET_STATUS_VALUES)).toBeUndefined();
    expect(enumParam("", "status", ASSET_STATUS_VALUES)).toBeUndefined();
  });

  it("rejects values outside the route enum set", () => {
    expect(() => enumParam("unknown", "status", ASSET_STATUS_VALUES)).toThrow(CoreApiError);
    expect(() => enumParam("unknown", "status", ASSET_STATUS_VALUES)).toThrow("status is invalid.");
  });

  it("validates platforms against the canonical domain roster", () => {
    expect(platformParam("tiktok")).toBe("tiktok");
    expect(() => platformParam("unknown")).toThrow("The platform is not supported.");
  });
});
