import { Effect } from "effect";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import {
  cachedProviderRegistryFromEnvironment,
  revokeEffect,
  type ProviderAdapterError,
  type ProviderRegistry,
} from "@meltiply/providers";

import { RetryableJobError, TerminalJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import type { OutboxMessage } from "./messages";
import { decryptStoredToken } from "./provider-credentials";

/**
 * Injectable seams for channel revocation processing. Tests substitute the
 * registry and decryptor so the processor never touches live provider
 * configuration or the token cipher.
 */
export interface ChannelRevocationDependencies {
  decryptToken?: (storedToken: string) => Promise<string>;
  providerRegistry?: ProviderRegistry;
}

/**
 * Processes one `channel.revocation.requested` outbox message by revoking the
 * channel's access token at the provider.
 *
 * The API enqueues this command after the local platform account row is
 * already deleted, so the still-encrypted token travels in the message payload
 * and is decrypted only here, at the provider boundary. Provider adapter
 * failures — including ambiguous outcomes — are re-failed as RetryableJobError
 * so the queue's retry/DLQ policy keeps attempting revocation: a revoke that
 * may have committed remotely is safe to replay, and a dropped revocation
 * would leave a live credential. A missing adapter fails retryable (a deploy
 * gap can close), while an adapter without revoke support resolves "skipped",
 * matching the API's silent-success semantics. Malformed payloads fail
 * terminally instead of burning the retry budget.
 *
 * @param env - Automation worker environment bindings (token key, provider config).
 * @param message - Validated outbox queue message carrying the encrypted token.
 * @param dependencies - Optional registry/decryptor overrides for tests.
 * @returns Effect resolving "processed" (revoked) or "skipped" (adapter has no
 *   revoke); fails with AutomationJobError for retryable or terminal outcomes.
 */
export function processChannelRevocationMessage(
  env: AutomationEnv,
  message: OutboxMessage,
  dependencies: ChannelRevocationDependencies = {},
): Effect.Effect<"processed" | "skipped", AutomationJobError> {
  return Effect.gen(function* () {
    const platform = message.payload.platform;
    const accessToken = message.payload.access_token;
    if (typeof platform !== "string" || typeof accessToken !== "string") {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "channel_revocation_payload_invalid",
          message: "channel revocation message is missing its platform or access token",
        }),
      );
    }
    if (!PLATFORM_IDS.includes(platform as Platform)) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "channel_revocation_payload_invalid",
          message: `channel revocation platform is unsupported: ${platform}`,
        }),
      );
    }
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const adapter = registry.get(platform as Platform);
    if (!adapter) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "provider_not_configured",
          message: `no provider adapter is configured for ${platform}`,
        }),
      );
    }
    if (!adapter.revoke) return "skipped" as const;
    const decryptToken = dependencies.decryptToken ?? decryptStoredToken(env);
    const plaintext = yield* Effect.tryPromise({
      catch: () =>
        new RetryableJobError({
          cause: "token_decryption_failed",
          message: "channel credential could not be decrypted",
        }),
      try: () => decryptToken(accessToken),
    });
    return yield* revokeEffect(adapter, plaintext).pipe(
      Effect.mapError(
        (error: ProviderAdapterError) =>
          new RetryableJobError({
            cause: error.name,
            message: `${error.failure.code}: ${error.message}`,
          }),
      ),
      Effect.as("processed" as const),
    );
  });
}
