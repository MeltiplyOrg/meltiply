import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect, Exit } from "effect";
import {
  ProviderAdapterError,
  ProviderService,
  type ProviderPublicationRequirements,
  type ProviderRegistry,
} from "@meltiply/providers";

import { CoreApiError } from "./core-types";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { tokenCipherFor } from "./token-credentials";

interface PublicationAccountRow extends Record<string, unknown> {
  access_token: string;
  connection_status: string;
  platform: Platform;
  platform_user_id: string;
  revoked_at: Date | string | null;
  token_expires_at: Date | string | null;
  updated_at: Date | string;
}

function providerFailure(cause: ProviderAdapterError): CoreApiError {
  switch (cause.failure.classification) {
    case "auth":
      return new CoreApiError(409, "invalid_state", "The platform account must be reconnected.");
    case "deterministic":
    case "quota":
      return new CoreApiError(
        422,
        "unsupported_capability",
        "Publishing is not currently available for this creator.",
      );
    case "rate_limit":
      return new CoreApiError(
        429,
        "provider_rate_limited",
        "The provider rate limit has been reached.",
        cause.failure.retryAfterSeconds,
      );
    case "ambiguous":
    case "timeout":
    case "transient":
      return new CoreApiError(
        502,
        "provider_unavailable",
        "The provider is temporarily unavailable.",
      );
  }
}

function isUnavailable(account: PublicationAccountRow, now: Date): boolean {
  if (account.revoked_at || !["connected", "expiring"].includes(account.connection_status)) {
    return true;
  }
  if (!account.token_expires_at) return false;
  const expiresAt = new Date(account.token_expires_at);
  return !Number.isFinite(expiresAt.getTime()) || expiresAt <= now;
}

const maxPendingRequirementReads = 32;

type RequirementReadExit = Exit.Exit<ProviderPublicationRequirements, CoreApiError>;

interface PendingRequirementRead {
  readonly promise: Promise<RequirementReadExit>;
  readonly settle: (exit: RequirementReadExit) => void;
}

interface RequirementReadOwner {
  readonly namespace: string;
  readonly dataSource: string | undefined;
  readonly pending: Map<string, PendingRequirementRead>;
}

interface RequirementReadFlight extends PendingRequirementRead {
  readonly leader: boolean;
  readonly release: () => void;
}

const requirementRegistryIds = new WeakMap<ProviderRegistry, number>();
let nextRequirementRegistryId = 1;
let requirementReadOwner: RequirementReadOwner | undefined;

function requirementReadNamespace(env: ApiWorkerEnv, registry: ProviderRegistry): string {
  let registryId = requirementRegistryIds.get(registry);
  if (registryId === undefined) {
    registryId = nextRequirementRegistryId;
    nextRequirementRegistryId += 1;
    requirementRegistryIds.set(registry, registryId);
  }
  return [env.ENVIRONMENT, env.VERSION, env.APP_URL ?? "", registryId].join("\u0000");
}

function nonSecretFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const firstHex = (first >>> 0).toString(16).padStart(8, "0");
  const secondHex = (second >>> 0).toString(16).padStart(8, "0");
  return `${firstHex}${secondHex}`;
}

function timestampKey(value: Date | string | null): string {
  if (value === null) return "";
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : String(value);
}

function requirementReadKey(
  session: SessionClaims,
  accountId: string,
  account: PublicationAccountRow,
): string {
  return [
    session.organizationId ?? "",
    session.subject,
    session.userId ?? "",
    session.organizationRole ?? "",
    accountId,
    account.platform,
    account.platform_user_id,
    account.connection_status,
    account.updated_at instanceof Date ? account.updated_at.toISOString() : account.updated_at,
    timestampKey(account.token_expires_at),
    timestampKey(account.revoked_at),
    nonSecretFingerprint(account.access_token),
  ].join("\u0000");
}

function acquireRequirementRead(
  namespace: string,
  key: string,
  dataSource: string | undefined,
): RequirementReadFlight | undefined {
  let owner = requirementReadOwner;
  if (owner?.namespace !== namespace || owner.dataSource !== dataSource) {
    owner?.pending.clear();
    owner = { namespace, dataSource, pending: new Map() };
    requirementReadOwner = owner;
  }
  const existing = owner.pending.get(key);
  if (existing) return { ...existing, leader: false, release: () => undefined };
  if (owner.pending.size >= maxPendingRequirementReads) return undefined;
  let settle!: PendingRequirementRead["settle"];
  const promise = new Promise<RequirementReadExit>((resolve) => {
    settle = resolve;
  });
  const entry: PendingRequirementRead = { promise, settle };
  owner.pending.set(key, entry);
  return {
    ...entry,
    leader: true,
    release: () => {
      if (owner.pending.get(key) === entry) owner.pending.delete(key);
    },
  };
}

function leadRequirementRead(
  flight: RequirementReadFlight,
  providerRead: Effect.Effect<ProviderPublicationRequirements, CoreApiError, ProviderService>,
): Effect.Effect<ProviderPublicationRequirements, CoreApiError, ProviderService> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(providerRead);
      yield* Effect.sync(() => {
        flight.release();
        flight.settle(exit);
      });
      return yield* Exit.isSuccess(exit)
        ? Effect.succeed(exit.value)
        : Effect.failCause(exit.cause);
    }),
  );
}

function providerRequirementsEffect(
  account: PublicationAccountRow,
  accessToken: string,
  requestId: string,
): Effect.Effect<ProviderPublicationRequirements, CoreApiError, ProviderService> {
  return Effect.flatMap(ProviderService, (service) =>
    service
      .getPublicationRequirements(
        account.platform,
        {
          operationId: "getPlatformPublishingRequirements",
          requestId,
        },
        {
          accessToken,
          accountId: account.platform_user_id,
        },
      )
      .pipe(
        Effect.catch((cause) => {
          if (
            cause instanceof ProviderAdapterError &&
            cause.failure.code !== "provider_unexpected"
          ) {
            return Effect.fail(providerFailure(cause));
          }
          return Effect.fail(
            new CoreApiError(
              502,
              "provider_unavailable",
              "The provider is temporarily unavailable.",
            ),
          );
        }),
      ),
  );
}

export function getPublicationRequirementsEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  requestId: string,
  registry: ProviderRegistry,
  now = new Date(),
): Effect.Effect<ProviderPublicationRequirements, CoreApiError | DatabaseError, ProviderService> {
  return Effect.gen(function* () {
    const account = yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<PublicationAccountRow>(
          `SELECT platform, platform_user_id, access_token, connection_status,
                    token_expires_at, revoked_at, extract(epoch FROM updated_at)::text AS updated_at
               FROM platform_accounts
               WHERE id = $1
               LIMIT 1`,
          [accountId],
        );
        return result.rows[0] ?? null;
      }),
    );
    if (!account) {
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The platform account was not found."),
      );
    }
    if (isUnavailable(account, now)) {
      return yield* Effect.fail(
        new CoreApiError(409, "invalid_state", "The platform account must be reconnected."),
      );
    }
    const adapter = registry.get(account.platform);
    if (!adapter?.getPublicationRequirements) {
      return yield* Effect.fail(
        new CoreApiError(
          422,
          "unsupported_capability",
          "Publishing requirements are not available for this platform.",
        ),
      );
    }
    const accessToken = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new CoreApiError(
              503,
              "dependency_unavailable",
              "Platform credentials are temporarily unavailable.",
            ),
      try: () => tokenCipherFor(env).decrypt(account.access_token),
    });
    const providerRead = providerRequirementsEffect(account, accessToken, requestId);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const flight = acquireRequirementRead(
          requirementReadNamespace(env, registry),
          requirementReadKey(session, accountId, account),
          env.DB_AUTHENTICATED?.connectionString,
        );
        if (!flight) return restore(providerRead);
        if (flight.leader) return leadRequirementRead(flight, providerRead);
        return restore(
          Effect.gen(function* () {
            const exit = yield* Effect.promise(() => flight.promise);
            return yield* Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.failCause(exit.cause);
          }),
        );
      }),
    );
  });
}
