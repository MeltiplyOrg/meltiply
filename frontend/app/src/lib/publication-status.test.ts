import { describe, expect, it } from "vite-plus/test";
import type { DistributionStatus } from "@meltiply/domain";

import {
  comparePublicationStatusGroup,
  isCancellablePublicationStatus,
  isDeleteProtectedPublicationStatus,
  isInFlightPublicationStatus,
  publicationStatusFilterBucket,
  resolvePublicationStatus,
  summarizePublicationStatuses,
} from "./publication-status";

const DISTRIBUTION_STATUSES = [
  "scheduled",
  "queued",
  "processing",
  "awaiting_provider",
  "published",
  "failed",
  "cancel_requested",
  "cancelled",
  "needs_reconciliation",
] as const satisfies readonly DistributionStatus[];

describe("resolvePublicationStatus", () => {
  it.each(DISTRIBUTION_STATUSES)("keeps the contract status %s unchanged", (status) => {
    expect(resolvePublicationStatus(status)).toBe(status);
  });

  it("keeps the Post draft state and the client unknown fallback", () => {
    expect(resolvePublicationStatus("draft")).toBe("draft");
    expect(resolvePublicationStatus("unknown")).toBe("unknown");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolvePublicationStatus("  PUBLISHED  ")).toBe("published");
    expect(resolvePublicationStatus("Needs_Reconciliation")).toBe("needs_reconciliation");
  });

  it.each([
    { value: "", label: "absent" },
    { value: "   ", label: "blank" },
    { value: null, label: "null" },
    { value: undefined, label: "undefined" },
    { value: "future_provider_status", label: "a new provider state" },
    { value: "publishing", label: "a superseded client-only state" },
  ])("treats $label as unknown", ({ value }) => {
    expect(resolvePublicationStatus(value)).toBe("unknown");
  });
});

describe("canonical publication status classification", () => {
  it("keeps only pending outcomes cancellable", () => {
    for (const status of [
      "scheduled",
      "queued",
      "processing",
      "awaiting_provider",
      "needs_reconciliation",
    ]) {
      expect(isCancellablePublicationStatus(status), status).toBe(true);
    }
    for (const status of [
      "draft",
      "published",
      "failed",
      "cancel_requested",
      "cancelled",
      "unknown",
    ]) {
      expect(isCancellablePublicationStatus(status), status).toBe(false);
    }
  });

  it("protects every status whose Provider attempt may have published", () => {
    for (const status of ["processing", "awaiting_provider", "published", "needs_reconciliation"]) {
      expect(isDeleteProtectedPublicationStatus(status), status).toBe(true);
    }
    for (const status of [
      "draft",
      "scheduled",
      "queued",
      "failed",
      "cancel_requested",
      "cancelled",
      "unknown",
    ]) {
      expect(isDeleteProtectedPublicationStatus(status), status).toBe(false);
    }
  });

  it("polls unresolved outcomes without polling an untouched schedule", () => {
    for (const status of ["queued", "processing", "awaiting_provider", "cancel_requested"]) {
      expect(isInFlightPublicationStatus(status), status).toBe(true);
    }
    for (const status of ["draft", "scheduled", "published", "failed", "cancelled", "unknown"]) {
      expect(isInFlightPublicationStatus(status), status).toBe(false);
    }
  });

  it.each([
    ["draft", "draft"],
    ["scheduled", "scheduled"],
    ["queued", "scheduled"],
    ["processing", "scheduled"],
    ["awaiting_provider", "scheduled"],
    ["cancel_requested", "scheduled"],
    ["published", "published"],
    ["failed", "failed"],
    ["needs_reconciliation", "failed"],
    ["cancelled", null],
    ["unknown", null],
  ] as const)("maps %s to the %s toolbar bucket", (status, bucket) => {
    expect(publicationStatusFilterBucket(status)).toBe(bucket);
  });
});

describe("summarizePublicationStatuses", () => {
  it("uses the fallback when a Post has no Channel outcome yet", () => {
    expect(summarizePublicationStatuses([], "scheduled")).toBe("scheduled");
    expect(summarizePublicationStatuses([], "draft")).toBe("draft");
  });

  it("surfaces actionable outcomes before pending and terminal ones", () => {
    expect(
      summarizePublicationStatuses([
        "published",
        "scheduled",
        "queued",
        "processing",
        "awaiting_provider",
        "needs_reconciliation",
        "failed",
        "cancelled",
      ]),
    ).toBe("failed");
    expect(summarizePublicationStatuses(["published", "scheduled", "processing"])).toBe(
      "processing",
    );
    expect(summarizePublicationStatuses(["published", "scheduled", "queued"])).toBe("queued");
    expect(summarizePublicationStatuses(["published", "scheduled"])).toBe("scheduled");
    expect(summarizePublicationStatuses(["published", "cancelled"])).toBe("cancelled");
    expect(summarizePublicationStatuses(["published"])).toBe("published");
  });

  it("never lets an unknown value outrank a known outcome", () => {
    expect(summarizePublicationStatuses(["future_provider_status", "published"])).toBe("published");
    expect(summarizePublicationStatuses(["future_provider_status"])).toBe("unknown");
    expect(summarizePublicationStatuses([""])).toBe("unknown");
  });

  it("normalizes case and never falls through to the fallback for real outcomes", () => {
    expect(summarizePublicationStatuses(["PUBLISHED"], "scheduled")).toBe("published");
    expect(summarizePublicationStatuses(["future_provider_status"], "scheduled")).toBe("unknown");
  });
});

describe("comparePublicationStatusGroup", () => {
  it("orders the lifecycle from draft through unknown", () => {
    const statuses = [
      "unknown",
      "cancelled",
      "cancel_requested",
      "needs_reconciliation",
      "failed",
      "published",
      "awaiting_provider",
      "processing",
      "queued",
      "scheduled",
      "draft",
    ] as const;
    expect([...statuses].sort(comparePublicationStatusGroup)).toEqual([
      "draft",
      "scheduled",
      "queued",
      "processing",
      "awaiting_provider",
      "published",
      "failed",
      "needs_reconciliation",
      "cancel_requested",
      "cancelled",
      "unknown",
    ]);
  });
});
