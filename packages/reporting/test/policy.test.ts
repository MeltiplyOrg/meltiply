import { describe, expect, it } from "vite-plus/test";

import { reportingConfiguration } from "../src/configuration";
import { categoryStatus, retryDelaySeconds } from "../src/policy";
import type { PreferencesRow } from "../src/policy";

// Corrupt consent fails closed; declined metadata remains readable.

const enabledConfiguration = reportingConfiguration({
  DEPLOYMENT_CATEGORY: "selfhosted",
  REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
  REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123",
});

const row: PreferencesRow = {
  diagnostics_decided_at: "2026-01-02T03:04:05.000Z",
  diagnostics_disclosure_version: 1,
  diagnostics_interval_started_at: "2026-01-02T03:04:05.000Z",
  diagnostics_requested: true,
  installation_reporting_id: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
  schema_version: 1,
  usage_decided_at: "2026-01-02T03:04:05.000Z",
  usage_disclosure_version: 1,
  usage_interval_started_at: "2026-01-02T03:04:05.000Z",
  usage_requested: true,
};

describe("category status", () => {
  it("fails closed when the stored preference schema version is unknown", () => {
    const status = categoryStatus(
      { ...row, schema_version: 99 },
      "diagnostics",
      enabledConfiguration,
    );

    expect(status.effective).toBe(false);
    expect(status.reason).toBe("preference_unavailable");
  });

  it("fails closed when a requested category has no recorded disclosure version", () => {
    const status = categoryStatus(
      { ...row, usage_disclosure_version: null },
      "usage",
      enabledConfiguration,
    );

    // A stored request without a disclosure decision is not consent: the Owner
    // never saw a text that authorized this payload.
    expect(status.requested).toBe(true);
    expect(status.effective).toBe(false);
    expect(status.reason).toBe("preference_unavailable");
    expect(status.disclosureVersion).toBeNull();
  });

  it("fails closed when a requested category agreed to a different disclosure version", () => {
    const status = categoryStatus(
      { ...row, diagnostics_disclosure_version: 7 },
      "diagnostics",
      enabledConfiguration,
    );

    expect(status.effective).toBe(false);
    expect(status.reason).toBe("preference_unavailable");
    // The retained metadata stays truthful rather than being upgraded to today's
    // version.
    expect(status.disclosureVersion).toBe(7);
  });

  it("keeps a declined category readable even with no disclosure version", () => {
    const status = categoryStatus(
      {
        ...row,
        usage_disclosure_version: null,
        usage_interval_started_at: null,
        usage_requested: false,
      },
      "usage",
      enabledConfiguration,
    );

    // Nothing is requested, so there is nothing to withhold: the surface still
    // explains that the Owner never asked.
    expect(status.effective).toBe(false);
    expect(status.reason).toBe("not_requested");
  });
});

describe("retry backoff", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("backs off exponentially without exceeding an hour", () => {
    const expiresAt = new Date("2026-01-06T00:00:00.000Z");
    expect(retryDelaySeconds(1, expiresAt, now)).toBe(300);
    expect(retryDelaySeconds(2, expiresAt, now)).toBe(600);
    expect(retryDelaySeconds(10, expiresAt, now)).toBe(3_600);
  });

  it("declines a retry that would land after the report expired", () => {
    const expiresAt = new Date("2026-01-02T00:04:00.000Z");
    expect(retryDelaySeconds(1, expiresAt, now)).toBeNull();
  });
});
