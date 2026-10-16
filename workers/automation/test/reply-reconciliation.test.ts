import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/database", () => ({ withSystemTransactionEffect: vi.fn() }));

import { withSystemTransactionEffect } from "../src/database";
import { RetryableJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import {
  processReplyMessage,
  replyReconciliationCadenceSeconds,
  type ReplyProcessingDependencies,
} from "../src/replies";
import { enqueueDueReplyReconciliations } from "../src/reply-reconciliation";

const env = {
  ENVIRONMENT: "test",
  VERSION: "test",
} satisfies AutomationEnv;

describe("reply reconciliation enqueue", () => {
  it.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s",
    async (limit) => {
      // The RangeError contract surfaces as a classified failure inside the
      // Effect: RetryableJobError keeps "RangeError" on its `cause` field.
      const failure = await Effect.runPromise(
        Effect.flip(enqueueDueReplyReconciliations(env, limit)),
      );
      expect(failure).toBeInstanceOf(RetryableJobError);
      expect(failure).toMatchObject({ cause: "RangeError" });
      expect(withSystemTransactionEffect).not.toHaveBeenCalled();
    },
  );
});
describe("reply reconciliation cadence", () => {
  it.each([
    { attempt: 0, expected: 60 },
    { attempt: 1, expected: 60 },
    { attempt: 2, expected: 120 },
    { attempt: 3, expected: 240 },
    { attempt: 4, expected: 480 },
    { attempt: 5, expected: 960 },
    { attempt: 6, expected: 1920 },
    { attempt: 7, expected: 3600 },
    { attempt: 10, expected: 3600 },
  ])(
    "calculates exponential cadence of $expected seconds for attempt $attempt",
    ({ attempt, expected }) => {
      expect(replyReconciliationCadenceSeconds(attempt)).toBe(expected);
    },
  );
});

describe("reply reconciliation delayed triggers", () => {
  const commentId = "80000000-0000-4000-8000-000000000001";
  const orgId = "80000000-0000-4000-8000-000000000002";
  const distributionId = "80000000-0000-4000-8000-000000000003";

  const replyMessage: OutboxMessage = {
    aggregate_id: commentId,
    attempt: 1,
    event_id: "80000000-0000-4000-8000-000000000101",
    organization_id: orgId,
    payload: { comment_id: commentId, reconciliation: true },
    topic: "comment.reply.requested",
    type: "outbox.event",
    version: 1,
  };

  function commentRow(overrides: Record<string, unknown> = {}) {
    return {
      access_token: "enc-token",
      comment_id: commentId,
      connection_status: "connected",
      distribution_id: distributionId,
      org_id: orgId,
      platform: "threads",
      platform_comment_id: "thread-c-1",
      platform_user_id: "user-1",
      provider_operation_id: null,
      provider_post_id: null,
      replied: false,
      reply_attempt_count: 0,
      reply_reconciliation_attempt_count: 0,
      reply_status: "queued",
      reply_text: "Great point!",
      token_expires_at: "2026-10-01T00:00:00Z",
      ...overrides,
    };
  }

  /**
   * Records every statement the reply path issues against a stub client so a test
   * can read back the Outbox entry it emitted. Comment and provider-operation updates
   * are mirrored onto the fixture rows so a later delivery observes persisted state.
   */
  function recordingTransaction(
    comment: Record<string, unknown>,
    operation: Record<string, unknown> | null,
  ) {
    const statements: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      statements.push({ params, sql });
      if (sql.includes("FROM comments AS comment")) {
        return Effect.succeed({ rowCount: 1, rows: [comment] });
      }
      if (sql.includes("FROM provider_operations")) {
        return operation
          ? Effect.succeed({ rowCount: 1, rows: [operation] })
          : Effect.succeed({ rowCount: 0, rows: [] });
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-db-1" }] });
      }
      if (sql.includes("UPDATE comments")) {
        if (sql.includes("SET replied = true")) {
          comment.replied = true;
          comment.reply_status = "succeeded";
        }
        if (sql.includes("SET reply_status = 'needs_reconciliation'")) {
          comment.reply_status = "needs_reconciliation";
        }
        if (sql.includes("SET reply_status = 'in_progress'")) {
          comment.reply_status = "in_progress";
        }
        if (sql.includes("SET reply_status = $2")) {
          comment.reply_status = params?.[1];
        }
        if (sql.includes("reply_provider_operation_id = $2")) {
          comment.provider_operation_id = params?.[1];
        }
        if (sql.includes("reply_provider_post_id = $3")) {
          comment.provider_post_id = params?.[2];
        }
        if (sql.includes("reply_reconciliation_attempt_count + 1")) {
          comment.reply_reconciliation_attempt_count =
            (comment.reply_reconciliation_attempt_count as number) + 1;
        }
      }
      if (operation && sql.includes("UPDATE provider_operations")) {
        for (const status of ["succeeded", "needs_reconciliation", "failed"]) {
          if (sql.includes(`status = '${status}'`)) {
            operation.status = status;
          }
        }
        if (sql.includes("provider_operation_id = $2")) {
          operation.provider_operation_id = params?.[1];
        }
        if (sql.includes("provider_post_id = $3")) {
          operation.provider_post_id = params?.[2];
        }
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });
    const transaction = vi.fn(
      <T>(
        _env: AutomationEnv,
        run: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> => run({ query } as unknown as EffectTransactionClient),
    ) as unknown as NonNullable<ReplyProcessingDependencies["transaction"]>;
    return { statements, transaction };
  }

  function reconciliationEntry(statements: Array<{ params?: unknown[]; sql: string }>) {
    return statements.find(({ sql }) => sql.includes("INSERT INTO outbox_events"));
  }

  const confirmedReply = vi.fn(async () => ({
    outcome: "confirmed_success" as const,
    providerOperationId: "prov-op-1",
    providerPostId: "prov-post-1",
  }));

  function providerRegistry(overrides: Partial<ProviderAdapter>) {
    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: null,
        max_media_count: null,
        max_video_duration_sec: null,
        min_media_count: null,
        multi_asset_types: [],
        notes: [],
        platform: "threads",
        publish: false,
        reply: true,
      },
      reply: confirmedReply,
      retryPolicy: {
        baseDelaySeconds: 15,
        maxAttempts: 5,
        maxDelaySeconds: 300,
      },
      transferModes: [],
      ...overrides,
    });
    return registry;
  }

  const dependencies = {
    decryptToken: async () => "decrypted-token",
    now: () => new Date("2026-08-24T12:00:00Z"),
  };

  it("emits a reconciliation entry carrying the first cadence delay when a reply delivery is ambiguous", async () => {
    const { statements, transaction } = recordingTransaction(commentRow(), null);

    await expect(
      Effect.runPromise(
        processReplyMessage(env, replyMessage, {
          ...dependencies,
          providerRegistry: providerRegistry({
            reply: vi.fn(async () => ({
              failure: {
                classification: "ambiguous" as const,
                code: "provider_unknown",
                message: "Request timed out on provider side",
                retryable: false,
              },
              outcome: "unknown" as const,
              providerOperationId: "prov-op-ambiguous-1",
            })),
          }),
          transaction,
        }),
      ),
    ).rejects.toThrow(RetryableJobError);

    const entry = reconciliationEntry(statements);
    expect(entry?.sql).toContain("comment.reply.requested");
    expect(entry?.sql).toContain("comment-reply-reconcile:");
    expect(entry?.params).toEqual([orgId, commentId, 0, 60]);
  });

  it("advances the cadence on each reconciliation lookup that must retry", async () => {
    const { statements, transaction } = recordingTransaction(
      commentRow({
        provider_operation_id: "prov-op-ambiguous-1",
        reply_attempt_count: 1,
        reply_reconciliation_attempt_count: 1,
        reply_status: "needs_reconciliation",
      }),
      {
        attempt_count: 1,
        id: "op-db-1",
        provider_operation_id: "prov-op-ambiguous-1",
        provider_post_id: null,
        status: "needs_reconciliation",
      },
    );

    await expect(
      Effect.runPromise(
        processReplyMessage(env, replyMessage, {
          ...dependencies,
          providerRegistry: providerRegistry({
            lookupPublication: vi.fn(async () => ({
              providerOperationId: "prov-op-ambiguous-1",
              state: "processing" as const,
            })),
          }),
          transaction,
        }),
      ),
    ).rejects.toThrow(RetryableJobError);

    // Attempt count advanced to 2 while claiming, so the next attempt is 3.
    expect(reconciliationEntry(statements)?.params).toEqual([
      orgId,
      commentId,
      2,
      replyReconciliationCadenceSeconds(3),
    ]);
  });

  it("keeps an operation-only confirmed reply pending and arms delayed reconciliation", async () => {
    const { statements, transaction } = recordingTransaction(commentRow(), null);

    await expect(
      Effect.runPromise(
        processReplyMessage(env, replyMessage, {
          ...dependencies,
          providerRegistry: providerRegistry({
            reply: vi.fn(async () => ({
              outcome: "confirmed_success" as const,
              providerOperationId: "created:reply-container-1",
            })),
          }),
          transaction,
        }),
      ),
    ).resolves.toBe("processed");

    // The reply stays pending platform processing: no premature success write.
    expect(statements.some(({ sql }) => sql.includes("replied = true"))).toBe(false);
    const commentUpdate = statements.find(
      ({ sql }) =>
        sql.includes("UPDATE comments") && sql.includes("reply_status = 'needs_reconciliation'"),
    );
    expect(commentUpdate?.params).toEqual([commentId, "created:reply-container-1"]);
    const operationUpdate = statements.find(
      ({ sql }) =>
        sql.includes("UPDATE provider_operations") &&
        sql.includes("status = 'needs_reconciliation'"),
    );
    expect(operationUpdate?.params).toEqual(["op-db-1", "created:reply-container-1"]);
    // Durable due work is armed at the first cadence delay.
    expect(reconciliationEntry(statements)?.params).toEqual([
      orgId,
      commentId,
      0,
      replyReconciliationCadenceSeconds(1),
    ]);
  });

  it("marks reply success exactly once when a lookup finalizes the container", async () => {
    const { statements, transaction } = recordingTransaction(
      commentRow({
        provider_operation_id: "created:reply-container-1",
        reply_attempt_count: 1,
        reply_status: "needs_reconciliation",
      }),
      {
        attempt_count: 1,
        id: "op-db-1",
        provider_operation_id: "created:reply-container-1",
        provider_post_id: null,
        status: "needs_reconciliation",
      },
    );
    const lookupPublication = vi.fn(async () => ({
      result: {
        outcome: "confirmed_success" as const,
        providerOperationId: "submitted:reply-container-1",
        providerPostId: "reply-post-1",
      },
      state: "published" as const,
    }));
    const lookupMessage: OutboxMessage = {
      ...replyMessage,
      event_id: "80000000-0000-4000-8000-000000000102",
    };

    await expect(
      Effect.runPromise(
        processReplyMessage(env, lookupMessage, {
          ...dependencies,
          providerRegistry: providerRegistry({ lookupPublication }),
          transaction,
        }),
      ),
    ).resolves.toBe("processed");

    // The success write is atomic: it lands only while the comment is still
    // in a reply-pending status, so a duplicate finalization cannot re-mark it.
    const successUpdate = statements.find(({ sql }) => sql.includes("SET replied = true"));
    expect(successUpdate?.sql).toContain("reply_status IN ('in_progress', 'needs_reconciliation')");
    expect(successUpdate?.params).toEqual([
      commentId,
      "submitted:reply-container-1",
      "reply-post-1",
    ]);
    expect(reconciliationEntry(statements)).toBeUndefined();

    // A replayed reconciliation delivery observes the persisted success and
    // skips without invoking the provider again.
    await expect(
      Effect.runPromise(
        processReplyMessage(env, lookupMessage, {
          ...dependencies,
          providerRegistry: providerRegistry({ lookupPublication }),
          transaction,
        }),
      ),
    ).resolves.toBe("skipped");
    expect(lookupPublication).toHaveBeenCalledOnce();
    expect(statements.filter(({ sql }) => sql.includes("SET replied = true"))).toHaveLength(1);
  });

  it("stops reconciliation cadence when a lookup reports a terminal provider failure", async () => {
    const { statements, transaction } = recordingTransaction(
      commentRow({
        provider_operation_id: "created:reply-container-1",
        reply_attempt_count: 1,
        reply_status: "needs_reconciliation",
      }),
      {
        attempt_count: 1,
        id: "op-db-1",
        provider_operation_id: "created:reply-container-1",
        provider_post_id: null,
        status: "needs_reconciliation",
      },
    );

    await expect(
      Effect.runPromise(
        processReplyMessage(
          env,
          {
            ...replyMessage,
            event_id: "80000000-0000-4000-8000-000000000103",
          },
          {
            ...dependencies,
            providerRegistry: providerRegistry({
              lookupPublication: vi.fn(async () => ({
                result: {
                  failure: {
                    classification: "deterministic" as const,
                    code: "threads_media_failed",
                    message: "The provider could not process the reply media.",
                    retryable: false,
                  },
                  outcome: "confirmed_failure" as const,
                  providerOperationId: "created:reply-container-1",
                },
                state: "failed" as const,
              })),
            }),
            transaction,
          },
        ),
      ),
    ).resolves.toBe("processed");

    const failureUpdate = statements.find(
      ({ sql }) => sql.includes("UPDATE comments") && sql.includes("reply_status = $2"),
    );
    expect(failureUpdate?.params?.[1]).toBe("failed");
    expect(statements.some(({ sql }) => sql.includes("replied = true"))).toBe(false);
    expect(reconciliationEntry(statements)).toBeUndefined();
  });
});
