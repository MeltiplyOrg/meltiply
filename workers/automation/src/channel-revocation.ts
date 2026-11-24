import { Effect } from "effect";
import { isPlatform } from "@meltiply/domain";
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

export interface ChannelRevocationDependencies {
  decryptToken?: (storedToken: string) => Promise<string>;
  providerRegistry?: ProviderRegistry;
}

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
    if (!isPlatform(platform)) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "channel_revocation_payload_invalid",
          message: `channel revocation platform is unsupported: ${platform}`,
        }),
      );
    }
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const adapter = registry.get(platform);
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
