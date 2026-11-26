import { DatabaseError } from "@meltiply/domain";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ReportingConfiguration } from "../src/configuration";
import {
  REPORTING_MAX_DIAGNOSTICS_PER_HOUR,
  type CaptureEvent,
  type CaptureResult,
  type CaptureTransport,
  type DiagnosticReportInput,
  type UsageReportInput,
} from "../src/contracts";
import { createFakeReportingRepository, FakeReportingStore } from "../src/repository";
import {
  createReportingServiceLive,
  createReportingServiceTest,
  ReportingService,
} from "../src/service";
import { CAPTURE_TIMEOUT_MILLISECONDS } from "../src/transport";

const DESTINATION = {
  captureUrl: "https://us.i.posthog.com/i/v0/e/",
  projectToken: "phc_testToken1234567890",
};

const configured: ReportingConfiguration = {
  deploymentCategory: "selfhosted",
  destination: DESTINATION,
  forcedOff: false,
};

const forcedOff: ReportingConfiguration = { ...configured, forcedOff: true };
const unconfigured: ReportingConfiguration = { ...configured, destination: null };

const usageInput = (patch: Partial<UsageReportInput> = {}): UsageReportInput => ({
  channels: { youtube: 2 },
  engagement: {},
  engagementAsOf: null,
  engagementCoverage: null,
  publications: { distributions: { youtube: 3 }, posts: 2 },
  reportDate: "2026-02-01",
  ...patch,
});

const diagnosticInput = (patch: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput => ({
  category: "provider_failure",
  error: { name: "ProviderRateLimitError" },
  failureClass: "rate_limit",
  handled: true,
  occurredAt: "2026-02-01T10:15:00.000Z",
  operation: "publish",
  platform: "youtube",
  ...patch,
});

function setup(
  options: {
    configuration?: ReportingConfiguration;
    now?: () => Date;
    transport?: CaptureTransport | null;
  } = {},
) {
  let currentTime = new Date("2026-02-01T12:00:00.000Z");
  const now = options.now ?? (() => currentTime);
  const store = new FakeReportingStore(now);
  const captured: CaptureEvent[] = [];
  let nextResult: CaptureResult = { ok: true };
  const transport: CaptureTransport | null =
    options.transport !== undefined
      ? options.transport
      : {
          capture: async (event) => {
            captured.push(event);
            return nextResult;
          },
        };
  const layer = createReportingServiceLive({
    appVersion: "1.2.3",
    configuration: options.configuration ?? configured,
    now,
    repository: createFakeReportingRepository(store),
    transport,
  });
  const run = <A, E>(fn: (service: ReportingService["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.provide(Effect.flatMap(ReportingService, fn), layer));
  const fail = <A, E>(fn: (service: ReportingService["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flip(Effect.provide(Effect.flatMap(ReportingService, fn), layer)));
  const advanceMs = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const setTransportResult = (result: CaptureResult) => {
    nextResult = result;
  };
  return { advanceMs, captured, fail, run, setTransportResult, store };
}

describe("ReportingService", () => {
  describe("policy and setPreferences", () => {
    it("reports default disabled policy before any preference is saved", async () => {
      const { run } = setup();

      const snapshot = await run((s) => s.policy());

      expect(snapshot.installationReportingId).toEqual(null);
      expect(snapshot.categories.usage.effective).toEqual(false);
      expect(snapshot.categories.diagnostics.effective).toEqual(false);
    });

    it("opts into usage, assigns an installation id, and returns changed=false on identical save", async () => {
      const { advanceMs, run } = setup();

      const first = await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      expect(first.changed).toEqual(true);
      expect(first.policy.installationReportingId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.policy.categories.usage.effective).toEqual(true);
      expect(first.policy.categories.usage.intervalStartedAt).toEqual("2026-02-01T12:00:00.000Z");

      advanceMs(60_000);
      const second = await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      expect(second.changed).toEqual(false);
      expect(second.policy.installationReportingId).toEqual(first.policy.installationReportingId);
      expect(second.policy.categories.usage.intervalStartedAt).toEqual("2026-02-01T12:00:00.000Z");
    });

    it("discards queued rows of a withdrawn category and opens a new interval on re-enable", async () => {
      const { advanceMs, run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: true, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput()));
      await run((s) => s.enqueueDiagnostic(diagnosticInput()));

      advanceMs(60_000);
      await run((s) => s.setPreferences({ diagnostics: true, usage: false }));

      expect(store.pending.find((row) => row.category === "usage")).toMatchObject({
        last_error_code: "withdrawn",
        state: "discarded",
      });
      expect(store.pending.find((row) => row.category === "diagnostics")?.state).toEqual("pending");

      advanceMs(60_000);
      const reenabled = await run((s) => s.setPreferences({ diagnostics: true, usage: true }));
      expect(reenabled.policy.categories.usage.intervalStartedAt).toEqual(
        "2026-02-01T12:02:00.000Z",
      );
    });

    it("rolls back preference changes when the repository fails on commit", async () => {
      const { fail, run, store } = setup();
      const down = new DatabaseError({ message: "commit failed" });
      store.nextCommitFailure = down;

      expect(await fail((s) => s.setPreferences({ diagnostics: false, usage: true }))).toEqual(
        down,
      );
      expect(store.preferences).toEqual(null);
      expect((await run((s) => s.policy())).installationReportingId).toEqual(null);
    });
  });

  describe("feedbackState and submitFeedback", () => {
    it("reports not_shared before feedback is recorded", async () => {
      const { run } = setup();

      expect(await run((s) => s.feedbackState())).toEqual({
        deliveryStatus: "not_shared",
        discoverySource: null,
        shared: false,
        submittedAt: null,
      });
    });

    it("queues shareable feedback once and reflects delivery after transmission", async () => {
      const { run } = setup();

      const first = await run((s) => s.submitFeedback("github"));
      expect(first).toEqual({
        deliveryStatus: "pending",
        discoverySource: "github",
        shared: true,
        submittedAt: "2026-02-01T12:00:00.000Z",
      });

      const repeat = await run((s) => s.submitFeedback("friend_word_of_mouth"));
      expect(repeat).toEqual(first);

      await run((s) => s.deliverPending());
      expect(await run((s) => s.feedbackState())).toEqual({
        ...first,
        deliveryStatus: "delivered",
      });
    });

    it("records prefer_not_to_say locally without queuing a pending report", async () => {
      const { run, store } = setup();

      expect(await run((s) => s.submitFeedback("prefer_not_to_say"))).toEqual({
        deliveryStatus: "not_recorded",
        discoverySource: "prefer_not_to_say",
        shared: false,
        submittedAt: "2026-02-01T12:00:00.000Z",
      });
      expect(store.pending).toEqual([]);
    });

    it("records shareable feedback locally when reporting is forced off", async () => {
      const { run, store } = setup({ configuration: forcedOff });

      expect(await run((s) => s.submitFeedback("github"))).toEqual({
        deliveryStatus: "not_recorded",
        discoverySource: "github",
        shared: true,
        submittedAt: "2026-02-01T12:00:00.000Z",
      });
      expect(store.pending).toEqual([]);
    });
  });

  describe("enqueueUsageReport and enqueueDiagnostic", () => {
    it("skips usage report when usage reporting is disabled", async () => {
      const { run } = setup();

      expect(await run((s) => s.enqueueUsageReport(usageInput()))).toEqual("skipped");
    });

    it("queues one usage report per day and skips duplicate or mismatched interval", async () => {
      const { run } = setup();
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));

      expect(
        await run((s) =>
          s.enqueueUsageReport(
            usageInput({ expectedIntervalStartedAt: "2025-01-01T00:00:00.000Z" }),
          ),
        ),
      ).toEqual("skipped");
      expect(
        await run((s) =>
          s.enqueueUsageReport(
            usageInput({ expectedIntervalStartedAt: "2026-02-01T12:00:00.000Z" }),
          ),
        ),
      ).toEqual("queued");
      expect(await run((s) => s.enqueueUsageReport(usageInput()))).toEqual("skipped");
    });

    it("skips usage report when a delivery receipt already exists for that logical id", async () => {
      const { run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      store.receipts.push({
        category: "usage",
        event_timestamp: new Date("2026-02-01T12:00:00.000Z"),
        event_uuid: "evt-1",
        logical_id: "2026-02-01T12:00:00.000Z:2026-02-01",
        state: "sent",
      });

      expect(await run((s) => s.enqueueUsageReport(usageInput()))).toEqual("skipped");
    });

    it("queues diagnostics up to the hourly limit and skips beyond it", async () => {
      const { run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: true, usage: false }));

      expect(
        await run((s) => s.enqueueDiagnostic(diagnosticInput({ occurredAt: "not-a-date" }))),
      ).toEqual("queued");
      expect(store.pending[0]?.logical_id).toContain(":rate_limit:2026-02-01T12");

      for (let i = 1; i < REPORTING_MAX_DIAGNOSTICS_PER_HOUR; i++) {
        await run((s) => s.enqueueDiagnostic(diagnosticInput({ logicalId: `diag-${i}` })));
      }
      expect(
        await run((s) => s.enqueueDiagnostic(diagnosticInput({ logicalId: "diag-overflow" }))),
      ).toEqual("skipped");
    });
  });

  describe("deliverPending", () => {
    it("reports skipped=1 when nothing is due", async () => {
      const { run } = setup();

      expect(await run((s) => s.deliverPending())).toEqual({
        claimed: 0,
        delivered: 0,
        discarded: 0,
        failed: 0,
        released: 0,
        skipped: 1,
      });
    });

    it("delivers queued events via transport and marks them sent", async () => {
      const { captured, run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput()));

      expect(await run((s) => s.deliverPending())).toEqual({
        claimed: 1,
        delivered: 1,
        discarded: 0,
        failed: 0,
        released: 0,
        skipped: 0,
      });
      expect(captured).toHaveLength(1);
      expect(store.pending[0]?.state).toEqual("sent");
    });

    it("expires overdue reports and prunes terminal reports older than one hour into receipts", async () => {
      const { advanceMs, run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput({ reportDate: "2026-02-01" })));
      await run((s) => s.deliverPending());

      advanceMs(3_600_000);
      await run((s) => s.enqueueUsageReport(usageInput({ reportDate: "2026-02-02" })));
      store.pending[1]!.expires_at = new Date("2026-02-01T12:30:00.000Z");

      const summary = await run((s) => s.deliverPending());
      expect(summary).toEqual({
        claimed: 0,
        delivered: 0,
        discarded: 1,
        failed: 0,
        released: 0,
        skipped: 1,
      });
      expect(store.receipts).toHaveLength(1);
      expect(store.receipts[0]?.state).toEqual("sent");
    });

    it("reschedules retryable failures and discards terminal failures", async () => {
      const { run, setTransportResult, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: true, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput()));
      await run((s) => s.enqueueDiagnostic(diagnosticInput()));

      setTransportResult({ errorCode: "http_503", ok: false, retryable: true });
      const first = await run((s) => s.deliverPending({ limit: 1 }));
      expect(first).toEqual({
        claimed: 1,
        delivered: 0,
        discarded: 0,
        failed: 1,
        released: 0,
        skipped: 0,
      });
      expect(store.pending[0]?.state).toEqual("pending");
      expect(store.pending[0]?.last_error_code).toEqual("http_503");

      setTransportResult({ errorCode: "http_400", ok: false, retryable: false });
      const second = await run((s) => s.deliverPending({ limit: 1 }));
      expect(second).toEqual({
        claimed: 1,
        delivered: 0,
        discarded: 1,
        failed: 0,
        released: 0,
        skipped: 0,
      });
      expect(store.pending[1]?.state).toEqual("discarded");
    });

    it("discards reports with stale interval without calling transport", async () => {
      const { captured, run, store } = setup();
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput()));
      store.pending[0]!.interval_started_at = "2025-01-01T00:00:00.000Z";

      expect(await run((s) => s.deliverPending())).toEqual({
        claimed: 1,
        delivered: 0,
        discarded: 1,
        failed: 0,
        released: 0,
        skipped: 0,
      });
      expect(captured).toEqual([]);
      expect(store.pending[0]?.last_error_code).toEqual("stale_interval");
    });

    it("discards reports when no transport is configured", async () => {
      const { run, store } = setup({ configuration: unconfigured, transport: null });
      store.pending.push({
        attempts: 0,
        available_at: new Date("2026-02-01T11:00:00.000Z"),
        category: "feedback",
        created_at: new Date("2026-02-01T11:00:00.000Z"),
        distinct_id: "resp-1",
        event_name: "meltiply_installation_feedback",
        event_timestamp: new Date("2026-02-01T11:00:00.000Z"),
        event_uuid: "evt-1",
        expires_at: new Date("2026-02-10T11:00:00.000Z"),
        id: "p-1",
        interval_started_at: "2026-02-01T11:00:00.000Z",
        last_error_code: null,
        lease_expires_at: null,
        lease_token: null,
        logical_id: "resp-1",
        payload: { discovery_source: "github" },
        state: "pending",
        updated_at: new Date("2026-02-01T11:00:00.000Z"),
      });

      expect(await run((s) => s.deliverPending())).toEqual({
        claimed: 1,
        delivered: 0,
        discarded: 1,
        failed: 0,
        released: 0,
        skipped: 0,
      });
      expect(store.pending[0]?.last_error_code).toEqual("policy_revoked");
    });

    it("releases remaining claimed rows when the delivery budget is exhausted", async () => {
      let tick = 0;
      const base = new Date("2026-02-01T12:00:00.000Z").getTime();
      const { run, store } = setup({
        now: () => new Date(base + tick),
        transport: {
          capture: async () => {
            tick += CAPTURE_TIMEOUT_MILLISECONDS;
            return { ok: true };
          },
        },
      });
      await run((s) => s.setPreferences({ diagnostics: false, usage: true }));
      await run((s) => s.enqueueUsageReport(usageInput({ reportDate: "2026-02-01" })));
      await run((s) => s.enqueueUsageReport(usageInput({ reportDate: "2026-02-02" })));

      const summary = await run((s) =>
        s.deliverPending({ budgetMilliseconds: CAPTURE_TIMEOUT_MILLISECONDS + 1_000 }),
      );
      expect(summary).toEqual({
        claimed: 2,
        delivered: 1,
        discarded: 0,
        failed: 0,
        released: 1,
        skipped: 0,
      });
      expect(store.pending[1]?.state).toEqual("pending");
      expect(store.pending[1]?.attempts).toEqual(0);
    });
  });

  describe("createReportingServiceTest", () => {
    it("dies on unstubbed methods and executes provided stubs", async () => {
      const layer = createReportingServiceTest({
        enqueueDiagnostic: () => Effect.succeed("queued"),
      });

      const ok = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(ReportingService, (s) => s.enqueueDiagnostic(diagnosticInput())),
          layer,
        ),
      );
      expect(ok).toEqual("queued");

      const exit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.flatMap(ReportingService, (s) => s.policy()),
          layer,
        ),
      );
      expect(Exit.isFailure(exit)).toEqual(true);
    });
  });
});
