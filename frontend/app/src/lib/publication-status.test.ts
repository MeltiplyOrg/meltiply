import { describe, expect, it } from "vite-plus/test";

import {
  comparePublicationStatusGroup,
  isCancellablePublicationStatus,
  isDeleteProtectedPublicationStatus,
  isInFlightPublicationStatus,
  publicationStatusFilterBucket,
  resolvePublicationStatus,
  summarizePublicationStatuses,
} from "./publication-status";

describe("resolvePublicationStatus", () => {
  it.each([
    ["draft", "draft"],
    ["scheduled", "scheduled"],
    ["queued", "queued"],
    ["processing", "processing"],
    ["awaiting_provider", "awaiting_provider"],
    ["delivered", "delivered"],
    ["published", "published"],
    ["failed", "failed"],
    ["needs_reconciliation", "needs_reconciliation"],
    ["cancel_requested", "cancel_requested"],
    ["cancelled", "cancelled"],
    ["unknown", "unknown"],
    ["  PUBLISHED  ", "published"],
    ["Needs_Reconciliation", "needs_reconciliation"],
    ["", "unknown"],
    ["   ", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["future_provider_status", "unknown"],
    ["publishing", "unknown"],
    ["constructor", "unknown"],
  ])("the value %j", (value, status) => {
    expect(resolvePublicationStatus(value)).toEqual(status);
  });
});

describe("isCancellablePublicationStatus", () => {
  it.each([
    ["draft", false],
    ["scheduled", true],
    ["queued", true],
    ["processing", true],
    ["awaiting_provider", true],
    ["delivered", false],
    ["published", false],
    ["failed", false],
    ["needs_reconciliation", true],
    ["cancel_requested", false],
    ["cancelled", false],
    ["unknown", false],
  ])("a %s status", (status, cancellable) => {
    expect(isCancellablePublicationStatus(status)).toEqual(cancellable);
  });
});

describe("isDeleteProtectedPublicationStatus", () => {
  it.each([
    ["draft", false],
    ["scheduled", false],
    ["queued", false],
    ["processing", true],
    ["awaiting_provider", true],
    ["delivered", true],
    ["published", true],
    ["failed", false],
    ["needs_reconciliation", true],
    ["cancel_requested", false],
    ["cancelled", false],
    ["unknown", false],
  ])("a %s status", (status, deleteProtected) => {
    expect(isDeleteProtectedPublicationStatus(status)).toEqual(deleteProtected);
  });
});

describe("isInFlightPublicationStatus", () => {
  it.each([
    ["draft", false],
    ["scheduled", false],
    ["queued", true],
    ["processing", true],
    ["awaiting_provider", true],
    ["delivered", false],
    ["published", false],
    ["failed", false],
    ["needs_reconciliation", false],
    ["cancel_requested", true],
    ["cancelled", false],
    ["unknown", false],
  ])("a %s status", (status, inFlight) => {
    expect(isInFlightPublicationStatus(status)).toEqual(inFlight);
  });
});

describe("publicationStatusFilterBucket", () => {
  it.each([
    ["draft", "draft"],
    ["scheduled", "scheduled"],
    ["queued", "scheduled"],
    ["processing", "scheduled"],
    ["awaiting_provider", "scheduled"],
    ["delivered", null],
    ["published", "published"],
    ["failed", "failed"],
    ["needs_reconciliation", "failed"],
    ["cancel_requested", "scheduled"],
    ["cancelled", null],
    ["unknown", null],
  ])("a %s status", (status, bucket) => {
    expect(publicationStatusFilterBucket(status)).toEqual(bucket);
  });
});

describe("summarizePublicationStatuses", () => {
  it.each([
    ["no outcome and a scheduled fallback", [], "scheduled", "scheduled"],
    ["no outcome and a draft fallback", [], "draft", "draft"],
    ["no outcome and an unknown fallback", [], "later", "unknown"],
    [
      "a failure among every kind",
      ["published", "needs_reconciliation", "failed"],
      "draft",
      "failed",
    ],
    [
      "a reconciliation before processing",
      ["processing", "needs_reconciliation"],
      "draft",
      "needs_reconciliation",
    ],
    [
      "processing before a provider wait",
      ["awaiting_provider", "processing"],
      "draft",
      "processing",
    ],
    [
      "a provider wait before queued",
      ["queued", "awaiting_provider"],
      "draft",
      "awaiting_provider",
    ],
    ["queued before scheduled", ["scheduled", "queued"], "draft", "queued"],
    ["scheduled before a cancel request", ["cancel_requested", "scheduled"], "draft", "scheduled"],
    [
      "a cancel request before cancelled",
      ["cancelled", "cancel_requested"],
      "draft",
      "cancel_requested",
    ],
    ["cancelled before published", ["published", "cancelled"], "draft", "cancelled"],
    ["published before draft", ["draft", "published"], "draft", "published"],
    ["a native handoff beside a publication", ["published", "delivered"], "draft", "delivered"],
    ["one publication in capitals", ["PUBLISHED"], "scheduled", "published"],
    ["a new state beside a publication", ["future_state", "published"], "draft", "published"],
    ["only a new state", ["future_state"], "scheduled", "unknown"],
    ["only a null state", [null], "scheduled", "unknown"],
  ])("%s", (_example, statuses, fallback, summary) => {
    expect(summarizePublicationStatuses(statuses, fallback)).toEqual(summary);
  });

  it("no outcome and no fallback", () => {
    expect(summarizePublicationStatuses([])).toEqual("draft");
  });
});

describe("comparePublicationStatusGroup", () => {
  it("the whole lifecycle in reverse", () => {
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
    ];

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

  it.each([
    ["two statuses of one group", "delivered", "published", 0],
    ["an earlier status first", "draft", "scheduled", -1],
    ["a missing status last", null, "draft", 10],
  ])("%s", (_example, a, b, difference) => {
    expect(comparePublicationStatusGroup(a, b)).toEqual(difference);
  });
});
