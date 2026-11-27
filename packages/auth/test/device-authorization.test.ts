import { describe, expect, it } from "vite-plus/test";

import { deviceAuthorizationSettings } from "../src/device-authorization";

const device = {
  clientId: "melti-cli",
  expiresIn: "10m",
  interval: "5s",
  verificationUri: "https://auth.example.test/device",
} as const;

describe("deviceAuthorizationSettings", () => {
  it("no device authorization", () => {
    expect(deviceAuthorizationSettings(undefined, "https://auth.example.test")).toEqual(undefined);
  });

  it("a padded client ID and a bare verification origin", () => {
    const padded = {
      ...device,
      clientId: " melti-cli ",
      verificationUri: "https://AUTH.example.test",
    };

    expect(deviceAuthorizationSettings(padded, "https://auth.example.test")).toEqual({
      ...device,
      verificationUri: "https://auth.example.test/",
    });
  });

  it("a verification page on another origin without a base URL", () => {
    expect(deviceAuthorizationSettings(device, undefined)).toEqual(device);
  });

  it("a blank client ID", () => {
    expect(() => deviceAuthorizationSettings({ ...device, clientId: "  " }, undefined)).toThrow(
      new TypeError("device authorization requires an exact client identifier"),
    );
  });

  it("a verification page on another origin", () => {
    expect(() => deviceAuthorizationSettings(device, "https://app.example.test")).toThrow(
      new TypeError("device authorization verification URI must be same-origin"),
    );
  });

  it("a verification page that is not a URL", () => {
    expect(() =>
      deviceAuthorizationSettings({ ...device, verificationUri: "/device" }, undefined),
    ).toThrow(TypeError);
  });
});
