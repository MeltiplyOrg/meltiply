import { describe, expect, it } from "vite-plus/test";

import type { ReportingConfiguration } from "../src/configuration";
import {
  categoryEffective,
  categoryStatus,
  feedbackEffective,
  policySnapshot,
  retryDelaySeconds,
  type PreferencesRow,
} from "../src/policy";

const DESTINATION = {
  captureUrl: "https://us.i.posthog.com/i/v0/e/",
  projectToken: "phc_acceptanceTokenValue123",
};

const configured: ReportingConfiguration = {
  deploymentCategory: "selfhosted",
  destination: DESTINATION,
  forcedOff: false,
};
const forcedOff: ReportingConfiguration = { ...configured, forcedOff: true };
const unconfigured: ReportingConfiguration = { ...configured, destination: null };

const row: PreferencesRow = {
  diagnostics_decided_at: "2026-02-02T03:04:05.000Z",
  diagnostics_disclosure_version: 1,
  diagnostics_interval_started_at: new Date("2026-02-03T03:04:05.000Z"),
  diagnostics_requested: true,
  installation_reporting_id: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
  schema_version: 1,
  usage_decided_at: "2026-01-02T03:04:05.000Z",
  usage_disclosure_version: 1,
  usage_interval_started_at: "2026-01-03T03:04:05.000Z",
  usage_requested: true,
};

const usageEnabled = {
  decidedAt: "2026-01-02T03:04:05.000Z",
  disclosureVersion: 1,
  effective: true,
  intervalStartedAt: "2026-01-03T03:04:05.000Z",
  reason: "enabled",
  requested: true,
};

const diagnosticsEnabled = {
  decidedAt: "2026-02-02T03:04:05.000Z",
  disclosureVersion: 1,
  effective: true,
  intervalStartedAt: "2026-02-03T03:04:05.000Z",
  reason: "enabled",
  requested: true,
};

const nothingStored = {
  decidedAt: null,
  disclosureVersion: null,
  effective: false,
  intervalStartedAt: null,
  reason: "not_requested",
  requested: false,
};

describe("categoryStatus", () => {
  it.each([
    ["a requested usage category", "usage", usageEnabled],
    ["a requested diagnostics category", "diagnostics", diagnosticsEnabled],
  ] as const)("%s", (_example, category, status) => {
    expect(categoryStatus(row, category, configured)).toEqual(status);
  });

  it("no stored preference", () => {
    expect(categoryStatus(null, "usage", configured)).toEqual(nothingStored);
  });

  it("an unknown preference schema version", () => {
    const stored = { ...row, schema_version: 99 };

    expect(categoryStatus(stored, "usage", configured)).toEqual({
      ...usageEnabled,
      effective: false,
      reason: "preference_unavailable",
    });
  });

  it.each([
    ["a request with no disclosure version", null],
    ["a request against another disclosure version", 7],
  ])("%s", (_example, version) => {
    const stored = { ...row, usage_disclosure_version: version };

    expect(categoryStatus(stored, "usage", configured)).toEqual({
      ...usageEnabled,
      disclosureVersion: version,
      effective: false,
      reason: "preference_unavailable",
    });
  });

  it("a declined category with no disclosure version", () => {
    const stored = { ...row, usage_disclosure_version: null, usage_requested: false };

    expect(categoryStatus(stored, "usage", configured)).toEqual({
      ...usageEnabled,
      disclosureVersion: null,
      effective: false,
      reason: "not_requested",
      requested: false,
    });
  });

  it.each([
    ["an operator override", forcedOff, "operator_disabled"],
    ["no destination", unconfigured, "destination_unavailable"],
  ] as const)("%s", (_example, configuration, reason) => {
    expect(categoryStatus(row, "usage", configuration)).toEqual({
      ...usageEnabled,
      effective: false,
      reason,
    });
  });
});

describe("policySnapshot", () => {
  it("a stored preference", () => {
    expect(policySnapshot(row, configured)).toEqual({
      categories: { diagnostics: diagnosticsEnabled, usage: usageEnabled },
      destinationConfigured: true,
      disclosureVersion: 1,
      installationReportingId: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
      operatorForcedOff: false,
    });
  });

  it("nothing stored, no destination and an override", () => {
    const configuration = { ...unconfigured, forcedOff: true };

    expect(policySnapshot(null, configuration)).toEqual({
      categories: { diagnostics: nothingStored, usage: nothingStored },
      destinationConfigured: false,
      disclosureVersion: 1,
      installationReportingId: null,
      operatorForcedOff: true,
    });
  });
});

describe("categoryEffective", () => {
  it.each([
    ["an enabled category", "usage", true],
    ["a declined category", "diagnostics", false],
  ] as const)("%s", (_example, category, effective) => {
    const policy = policySnapshot({ ...row, diagnostics_requested: false }, configured);

    expect(categoryEffective(policy, category)).toEqual(effective);
  });
});

describe("feedbackEffective", () => {
  it.each([
    ["a configured destination", configured, true],
    ["an operator override", forcedOff, false],
    ["no destination", unconfigured, false],
  ])("%s", (_example, configuration, effective) => {
    expect(feedbackEffective(configuration)).toEqual(effective);
  });
});

describe("retryDelaySeconds", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");
  const distant = new Date("2026-01-06T00:00:00.000Z");

  it.each([
    ["no attempt yet", 0, 300],
    ["the first attempt", 1, 300],
    ["the second attempt", 2, 600],
    ["the last delay under an hour", 4, 2400],
    ["the first delay capped at an hour", 5, 3600],
    ["a tenth attempt", 10, 3600],
  ])("%s", (_example, attempts, delay) => {
    expect(retryDelaySeconds(attempts, distant, now)).toEqual(delay);
  });

  it.each([
    ["a retry just before the expiry", "2026-01-02T00:05:00.001Z", 300],
    ["a retry exactly at the expiry", "2026-01-02T00:05:00.000Z", null],
    ["a retry after the expiry", "2026-01-02T00:04:00.000Z", null],
  ])("%s", (_example, expiresAt, delay) => {
    expect(retryDelaySeconds(1, new Date(expiresAt), now)).toEqual(delay);
  });
});
