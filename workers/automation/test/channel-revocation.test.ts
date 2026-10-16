import type { EffectTransactionClient } from "@meltiply/database";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { processChannelRevocationMessage } from "../src/channel-revocation";
import {
  createPublishQueueResolverLive,
  createQueuePublisherLive,
  RetryableJobError,
  TerminalJobError,
} from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { createAutomationHandler } from "../src/index";
import type { OutboxMessage } from "../src/messages";
import { relayOutbox } from "../src/outbox";
import { publishingQueueFor } from "../src/publish-queues";

const organizationId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const eventId = "00000000-0000-4000-8000-0000000000aa";

/**
 * Builds one claimed outbox row whose payload exercises revocation allowlisting.
 *
 * @param overrides - Row fields replacing the deterministic baseline.
 * @returns Outbox row accepted by the relay fixture.
 */
function revocationRow(overrides: Record<string, unknown> = {}) {
  return {
    aggregate_id: accountId,
    attempt_count: 1,
    id: eventId,
    next_attempt_at: null,
    org_id: organizationId,
    payload: {
      access_token: "enc:ciphertext-token",
      brand_profile_id: "00000000-0000-4000-8000-000000000003",
      platform: "tiktok",
      request_id: "request-revocation-test",
      stray_field: "must-not-leak",
      version: 1,
    },
    platform: null,
    scheduled_at: null,
    topic: "channel.revocation.requested",
    ...overrides,
  };
}

/**
 * Builds a validated channel-revocation queue message for processor tests.
 *
 * @param payload - Payload replacing the minimal encrypted-token baseline.
 * @returns Outbox message with deterministic organization and account IDs.
 */
function revocationMessage(
  payload: Record<string, unknown> = {
    access_token: "enc:ciphertext-token",
    brand_profile_id: "00000000-0000-4000-8000-000000000003",
    platform: "tiktok",
    platform_account_id: accountId,
  },
): OutboxMessage {
  return {
    aggregate_id: accountId,
    event_id: eventId,
    organization_id: organizationId,
    payload,
    topic: "channel.revocation.requested",
    type: "outbox.event",
    version: 1,
  };
}

/**
 * Configures a two-query outbox claim transaction with deterministic row results.
 *
 * @param rows - Rows returned by the claim query.
 * @param updatedRows - Rows returned after claim state updates.
 * @returns Mock query function for call-level assertions.
 */
function setupClaim(rows: unknown[], updatedRows: { state: string }[] = []) {
  const query = vi
    .fn()
    .mockReturnValueOnce(Effect.succeed({ rows }))
    .mockReturnValueOnce(Effect.succeed({ rows: updatedRows }))
    .mockReturnValue(Effect.succeed({ rows: [] }));
  withSystemTransactionEffect.mockImplementation(
    (_env: AutomationEnv, operation: (client: EffectTransactionClient) => Effect.Effect<unknown>) =>
      operation({ query }),
  );
  return query;
}

/**
 * Executes the durable outbox relay with its concrete publish queue layers.
 *
 * @param environment - Automation bindings, including the revocation queue.
 * @returns Promise resolving after all claimed events have been relayed.
 */
function runRelay(environment: AutomationEnv) {
  return Effect.runPromise(
    Effect.provide(
      relayOutbox(environment),
      Layer.mergeAll(
        createQueuePublisherLive(),
        createPublishQueueResolverLive((platform) => publishingQueueFor(environment, platform)),
      ),
    ),
  );
}

/**
 * Creates a registry containing a minimal TikTok adapter with optional revocation support.
 *
 * @param revoke - Adapter revocation behavior used to model provider outcomes.
 * @returns Registry accepted by the channel-revocation processor.
 */
function revocationRegistry(revoke?: ProviderAdapter["revoke"]) {
  const registry = new ProviderRegistry();
  const adapter: ProviderAdapter = {
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
      platform: "tiktok",
      publish: false,
      reply: false,
    },
    transferModes: [],
    ...(revoke ? { revoke } : {}),
  };
  registry.register("tiktok", adapter);
  return registry;
}

describe("channel revocation outbox routing", () => {
  it("relays a revocation event to its queue with the strict payload allowlist", async () => {
    const batches: MessageSendRequest<OutboxMessage>[][] = [];
    const sendBatch = vi.fn(async (messages: Iterable<MessageSendRequest<OutboxMessage>>) => {
      batches.push([...messages]);
      return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
    });
    const query = setupClaim([revocationRow()]);
    const environment: AutomationEnv = {
      CHANNEL_REVOCATION_QUEUE: { sendBatch } as unknown as Queue<unknown>,
      ENVIRONMENT: "test",
      VERSION: "test",
    };

    await expect(runRelay(environment)).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const sent = batches[0]?.[0];
    expect(sent?.body.event_id).toBe(eventId);
    expect(sent?.body.topic).toBe("channel.revocation.requested");
    // The allowlist keeps the encrypted token and routing fields while
    // dropping producer-only keys (version, request_id, stray_field) — the
    // ciphertext must reach the consumer because the account row is gone.
    expect(sent?.body.payload).toEqual({
      access_token: "enc:ciphertext-token",
      brand_profile_id: "00000000-0000-4000-8000-000000000003",
      platform: "tiktok",
      platform_account_id: accountId,
    });
    expect(sent?.delaySeconds).toBeUndefined();
    expect(query.mock.calls[1]?.[1]).toEqual([[eventId]]);
  });

  it("marks the event failed instead of dropping it when the queue binding is missing", async () => {
    const query = setupClaim([revocationRow()]);
    const environment: AutomationEnv = {
      ENVIRONMENT: "test",
      VERSION: "test",
    };

    await expect(runRelay(environment)).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 1,
      published: 0,
    });

    expect(query.mock.calls[1]?.[1]).toEqual([
      [eventId],
      [30],
      ["channel-revocation Queue binding is unavailable"],
      10,
    ]);
  });
});

describe("channel revocation queue dispatch", () => {
  it("acks a processed revocation and retries a retryable provider failure", async () => {
    const processChannelRevocation = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed("processed" as const))
      .mockReturnValueOnce(
        Effect.fail(
          new RetryableJobError({
            cause: "ProviderAdapterError",
            message: "provider_transient: provider request failed",
          }),
        ),
      );
    const handler = createAutomationHandler({
      channelRevocationProcessor: processChannelRevocation,
    });
    const body = revocationMessage();
    const batch = createMessageBatch("meltiply-channel-revocation-test", [
      {
        attempts: 1,
        body,
        id: "revocation-success",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        attempts: 2,
        body: { ...body, event_id: "00000000-0000-4000-8000-0000000000bb" },
        id: "revocation-retry",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await handler.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["revocation-success"]);
    expect(result.retryMessages).toEqual([{ msgId: "revocation-retry" }]);
    expect(processChannelRevocation).toHaveBeenCalledTimes(2);
  });
});

describe("processChannelRevocationMessage", () => {
  const testEnv: AutomationEnv = { ENVIRONMENT: "test", VERSION: "test" };

  it("decrypts the stored token at the boundary and revokes through the adapter", async () => {
    const revoke = vi.fn(async () => undefined);
    const decryptToken = vi.fn(async () => "plaintext-token");

    await expect(
      Effect.runPromise(
        processChannelRevocationMessage(testEnv, revocationMessage(), {
          decryptToken,
          providerRegistry: revocationRegistry(revoke),
        }),
      ),
    ).resolves.toBe("processed");

    expect(decryptToken).toHaveBeenCalledWith("enc:ciphertext-token");
    expect(revoke).toHaveBeenCalledWith(
      "plaintext-token",
      expect.objectContaining({ operationId: "oauth-revoke" }),
    );
  });

  it("fails retryable when the provider revoke rejects, including ambiguous outcomes", async () => {
    const transient = new ProviderAdapterError(classifyProviderFailure({ status: 503 }));
    const ambiguous = new ProviderAdapterError(
      classifyProviderFailure({ timedOut: true, sideEffectPossible: true }),
    );
    const revoke = vi.fn().mockRejectedValueOnce(transient).mockRejectedValueOnce(ambiguous);
    const dependencies = {
      decryptToken: async () => "plaintext-token",
      providerRegistry: revocationRegistry(revoke),
    };

    const first = await Effect.runPromise(
      Effect.flip(processChannelRevocationMessage(testEnv, revocationMessage(), dependencies)),
    );
    const second = await Effect.runPromise(
      Effect.flip(processChannelRevocationMessage(testEnv, revocationMessage(), dependencies)),
    );

    // A revoke that may have committed remotely is safe to replay, so even
    // ambiguous failures stay retryable for the queue's retry/DLQ policy.
    expect(first).toBeInstanceOf(RetryableJobError);
    expect(second).toBeInstanceOf(RetryableJobError);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("skips adapters without revoke support instead of retrying", async () => {
    await expect(
      Effect.runPromise(
        processChannelRevocationMessage(testEnv, revocationMessage(), {
          decryptToken: async () => "plaintext-token",
          providerRegistry: revocationRegistry(),
        }),
      ),
    ).resolves.toBe("skipped");
  });

  it("fails terminally on a malformed payload or unsupported platform", async () => {
    const missingToken = await Effect.runPromise(
      Effect.flip(
        processChannelRevocationMessage(testEnv, revocationMessage({ platform: "tiktok" }), {
          providerRegistry: revocationRegistry(vi.fn(async () => undefined)),
        }),
      ),
    );
    const badPlatform = await Effect.runPromise(
      Effect.flip(
        processChannelRevocationMessage(
          testEnv,
          revocationMessage({
            access_token: "enc:ciphertext-token",
            platform: "myspace",
          }),
          {
            providerRegistry: revocationRegistry(vi.fn(async () => undefined)),
          },
        ),
      ),
    );

    expect(missingToken).toBeInstanceOf(TerminalJobError);
    expect(badPlatform).toBeInstanceOf(TerminalJobError);
  });
});
