import { describe, expect, it } from "vite-plus/test";

import {
  reportedAppVersion,
  reportingConfiguration,
  reportingDestination,
} from "../src/configuration";

const TOKEN = "phc_acceptanceTokenValue123";

describe("reportingDestination", () => {
  it.each([
    ["an https origin", "https://eu.i.posthog.com", "https://eu.i.posthog.com/i/v0/e/"],
    [
      "a trailing slash and padding",
      "  https://eu.i.posthog.com/  ",
      "https://eu.i.posthog.com/i/v0/e/",
    ],
    ["plain http on localhost", "http://localhost:9000", "http://localhost:9000/i/v0/e/"],
    ["plain http on a localhost subdomain", "http://ph.localhost", "http://ph.localhost/i/v0/e/"],
    ["plain http on the IPv4 loopback", "http://127.0.0.1:9000", "http://127.0.0.1:9000/i/v0/e/"],
    ["plain http on the IPv6 loopback", "http://[::1]:9000", "http://[::1]:9000/i/v0/e/"],
  ])("%s", (_example, host, captureUrl) => {
    expect(reportingDestination(host, TOKEN)).toEqual({ captureUrl, projectToken: TOKEN });
  });

  it.each([
    ["no host", undefined],
    ["a blank host", "   "],
    ["a host that is not a URL", "us.i.posthog.com"],
    ["a path", "https://us.i.posthog.com/v1"],
    ["a username", "https://user@us.i.posthog.com"],
    ["a password", "https://:pass@us.i.posthog.com"],
    ["a query", "https://us.i.posthog.com/?a=1"],
    ["a fragment", "https://us.i.posthog.com/#a"],
    ["another protocol", "ftp://us.i.posthog.com"],
    ["plain http on a remote host", "http://us.i.posthog.com"],
  ])("%s", (_example, host) => {
    expect(reportingDestination(host, TOKEN)).toEqual(null);
  });

  it.each([
    ["a token with 8 characters after the prefix", "phc_12345678"],
    ["a token with 200 characters after the prefix", `phc_${"a".repeat(200)}`],
  ])("%s", (_example, token) => {
    expect(reportingDestination("https://us.i.posthog.com", token)).toEqual({
      captureUrl: "https://us.i.posthog.com/i/v0/e/",
      projectToken: token,
    });
  });

  it.each([
    ["no token", undefined],
    ["a token without the prefix", "phx_acceptanceTokenValue123"],
    ["a token with 7 characters after the prefix", "phc_1234567"],
    ["a token with 201 characters after the prefix", `phc_${"a".repeat(201)}`],
  ])("%s", (_example, token) => {
    expect(reportingDestination("https://us.i.posthog.com", token)).toEqual(null);
  });
});

describe("reportingConfiguration", () => {
  it("no bindings", () => {
    expect(reportingConfiguration({})).toEqual({
      deploymentCategory: "unknown",
      destination: null,
      forcedOff: false,
    });
  });

  it("every binding", () => {
    const bindings = {
      DEPLOYMENT_CATEGORY: " selfhosted ",
      REPORTING_FORCED_OFF: " TRUE ",
      REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: TOKEN,
    };

    expect(reportingConfiguration(bindings)).toEqual({
      deploymentCategory: "selfhosted",
      destination: { captureUrl: "https://us.i.posthog.com/i/v0/e/", projectToken: TOKEN },
      forcedOff: true,
    });
  });

  it.each([
    ["a managed deployment", "managed", "managed"],
    ["an unrecognized deployment", "kubernetes", "unknown"],
  ])("%s", (_example, DEPLOYMENT_CATEGORY, deploymentCategory) => {
    expect(reportingConfiguration({ DEPLOYMENT_CATEGORY })).toEqual({
      deploymentCategory,
      destination: null,
      forcedOff: false,
    });
  });

  it("an override that is not true", () => {
    expect(reportingConfiguration({ REPORTING_FORCED_OFF: "1" })).toEqual({
      deploymentCategory: "unknown",
      destination: null,
      forcedOff: false,
    });
  });
});

describe("reportedAppVersion", () => {
  it.each([
    ["a padded version", " 1.0.0-target.0+build_1 ", "1.0.0-target.0+build_1"],
    ["a version of 40 characters", "1".repeat(40), "1".repeat(40)],
    ["a version of 41 characters", "1".repeat(41), "unknown"],
    ["a version with a space", "1.0 beta", "unknown"],
    ["a version outside ASCII", "1.0-β", "unknown"],
    ["a blank version", "   ", "unknown"],
    ["no version", undefined, "unknown"],
  ])("%s", (_example, value, expected) => {
    expect(reportedAppVersion(value)).toEqual(expected);
  });
});
