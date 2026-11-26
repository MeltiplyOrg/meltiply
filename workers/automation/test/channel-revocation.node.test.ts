import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { processChannelRevocationMessage } from "../src/channel-revocation";
import { RetryableJobError, TerminalJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";

const organizationId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const eventId = "00000000-0000-4000-8000-0000000000aa";
const testEnv: AutomationEnv = { ENVIRONMENT: "test", VERSION: "test" };

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

function revocationRegistry(revoke?: ProviderAdapter["revoke"]): ProviderRegistry {
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

describe("processChannelRevocationMessage", () => {
  it("decrypts the stored token at the boundary and revokes through the adapter", async () => {
    const decrypted: string[] = [];
    const revoked: Array<{ operationId: string | undefined; token: string }> = [];

    const outcome = await Effect.runPromise(
      processChannelRevocationMessage(testEnv, revocationMessage(), {
        decryptToken: async (stored) => {
          decrypted.push(stored);
          return "plaintext-token";
        },
        providerRegistry: revocationRegistry(async (token, context) => {
          revoked.push({ operationId: context?.operationId, token });
        }),
      }),
    );

    expect(outcome).toEqual("processed");
    expect(decrypted).toEqual(["enc:ciphertext-token"]);
    expect(revoked).toEqual([{ operationId: "oauth-revoke", token: "plaintext-token" }]);
  });

  it("fails retryable when the provider revoke rejects, including ambiguous outcomes", async () => {
    const failures = [
      new ProviderAdapterError(classifyProviderFailure({ status: 503 })),
      new ProviderAdapterError(
        classifyProviderFailure({ sideEffectPossible: true, timedOut: true }),
      ),
    ];
    let calls = 0;
    const dependencies = {
      decryptToken: async () => "plaintext-token",
      providerRegistry: revocationRegistry(async () => {
        const error = failures[calls];
        calls += 1;
        throw error;
      }),
    };

    const first = await Effect.runPromise(
      Effect.flip(processChannelRevocationMessage(testEnv, revocationMessage(), dependencies)),
    );
    const second = await Effect.runPromise(
      Effect.flip(processChannelRevocationMessage(testEnv, revocationMessage(), dependencies)),
    );

    expect(first).toBeInstanceOf(RetryableJobError);
    expect(second).toBeInstanceOf(RetryableJobError);
    expect(calls).toEqual(2);
  });

  it("skips adapters without revoke support instead of retrying", async () => {
    const outcome = await Effect.runPromise(
      processChannelRevocationMessage(testEnv, revocationMessage(), {
        decryptToken: async () => "plaintext-token",
        providerRegistry: revocationRegistry(),
      }),
    );

    expect(outcome).toEqual("skipped");
  });

  it("fails terminally on a malformed payload or unsupported platform", async () => {
    const registry = revocationRegistry(async () => undefined);
    const missingToken = await Effect.runPromise(
      Effect.flip(
        processChannelRevocationMessage(testEnv, revocationMessage({ platform: "tiktok" }), {
          providerRegistry: registry,
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
          { providerRegistry: registry },
        ),
      ),
    );

    expect(missingToken).toBeInstanceOf(TerminalJobError);
    expect(badPlatform).toBeInstanceOf(TerminalJobError);
  });
});
