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

/**
 * Translates upstream provider adapter error classifications into standardized API error responses.
 *
 * Maps `auth` to 409 `invalid_state`, `deterministic`/`quota` to 422 `unsupported_capability`,
 * `rate_limit` to 429 `provider_rate_limited` (preserving retry-after headers), and transient/timeout errors to 502 `provider_unavailable`.
 *
 * @param cause - ProviderAdapterError thrown by the provider integration layer.
 * @returns Mapped `CoreApiError` with appropriate HTTP status and client message.
 */
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

/**
 * Determines whether a platform account connection is unusable or expired.
 *
 * Checks if the account has been revoked, is in an invalid connection status,
 * or possesses an access token whose expiration timestamp is in the past.
 *
 * @param account - Stored platform account database row.
 * @param now - Current reference timestamp.
 * @returns `true` if the account cannot be used without re-authenticating, otherwise `false`.
 */
function isUnavailable(account: PublicationAccountRow, now: Date): boolean {
  if (account.revoked_at || !["connected", "expiring"].includes(account.connection_status)) {
    return true;
  }
  if (!account.token_expires_at) return false;
  const expiresAt = new Date(account.token_expires_at);
  return !Number.isFinite(expiresAt.getTime()) || expiresAt <= now;
}

/** Maximum distinct pending Provider requirement reads retained per configuration namespace. */
const maxPendingRequirementReads = 32;

/** Outcome of one shared Provider requirement read, replayed to every joining caller. */
type RequirementReadExit = Exit.Exit<ProviderPublicationRequirements, CoreApiError>;

interface PendingRequirementRead {
  readonly promise: Promise<RequirementReadExit>;
  readonly settle: (exit: RequirementReadExit) => void;
}

/**
 * Worker-local coalescing owner for one deployment/configuration namespace.
 *
 * A new environment or Provider registry replaces the owner instead of adding
 * another namespace, so configuration changes discard pending keys and retained
 * cardinality never grows with the number of configurations seen. Entries are
 * pending Provider reads only; settlement removes them.
 */
interface RequirementReadOwner {
  readonly namespace: string;
  /** Private configuration comparison only; never serialized into keys, responses or diagnostics. */
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

/**
 * Identifies the deployment and Provider configuration that may share pending work.
 *
 * One isolate serves one deployment environment, and the API app builds one
 * Provider registry from that environment, so the environment values plus the
 * registry identity are a stable non-secret namespace. Registry identity is
 * per instance rather than capability text because adapters with equal
 * capabilities may still point at different configurations. The namespace is
 * never logged or returned.
 *
 * @param env - Worker environment bindings for the current request.
 * @param registry - Provider registry that will execute the read.
 * @returns Null-delimited namespace string used only for in-memory ownership.
 */
function requirementReadNamespace(env: ApiWorkerEnv, registry: ProviderRegistry): string {
  let registryId = requirementRegistryIds.get(registry);
  if (registryId === undefined) {
    registryId = nextRequirementRegistryId;
    nextRequirementRegistryId += 1;
    requirementRegistryIds.set(registry, registryId);
  }
  return [env.ENVIRONMENT, env.VERSION, env.PUBLIC_API_URL ?? "", registryId].join("\u0000");
}

/**
 * Produces a stable short fingerprint for a credential ciphertext.
 *
 * Two interleaved 32-bit FNV-1a passes keep the key stable across requests and
 * processes without retaining, logging, or returning credential material.
 * Cryptographic strength is unnecessary: this value only separates connection
 * generations inside one runtime and never authorizes or encrypts anything.
 *
 * @param value - Opaque stored credential ciphertext.
 * @returns Sixteen hexadecimal characters derived from the ciphertext.
 */
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

/**
 * Normalizes a persisted timestamp for key equality across driver representations.
 *
 * @param value - Timestamp returned by the database, a test fixture, or null.
 * @returns Canonical ISO instant, or a stable fallback for an unparseable value.
 */
function timestampKey(value: Date | string | null): string {
  if (value === null) return "";
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : String(value);
}

/**
 * Builds the equivalence key for one authorized Provider requirement read.
 *
 * Every caller resolves its own account under tenant RLS before this key is
 * formed, so the key can safely be narrow. It carries the authorized identity
 * and Workspace, the Platform account, the adapter platform, and the persisted
 * connection generation: connection status, revocation, token expiry, row
 * freshness, and a ciphertext fingerprint. Credential contents never appear in
 * the key, and the caller's request ID is deliberately excluded because each
 * caller keeps its own response correlation.
 * Production row generations use exact PostgreSQL epoch text, preserving
 * microsecond updates that a JavaScript Date would collapse into one millisecond.
 *
 * @param session - Authenticated session claims used for tenant scoping.
 * @param accountId - Requested Platform account UUID.
 * @param account - Account row observed by this caller under RLS.
 * @returns Null-delimited key scoped to this owner namespace.
 */
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

/**
 * Acquires the pending read for a key, creates its leader entry, or declines at capacity.
 *
 * Acquisition is synchronous so two request fibers cannot both become leader for
 * one key. An existing equivalent key always joins, even at capacity; a new
 * distinct key beyond the bound returns undefined and its caller uses the normal
 * uncached Provider path. The returned release removes only the entry this call
 * created, so a namespace replacement cannot delete a newer owner's entry.
 *
 * @param namespace - Current deployment/configuration namespace.
 * @param key - Equivalence key built from freshly validated persisted state.
 * @param dataSource - Private connection configuration, compared exactly but never used as key material.
 * @returns Flight handle, or undefined when this caller must bypass coalescing.
 */
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

/**
 * Executes the leader's Provider read once and publishes its outcome to joiners.
 *
 * The read, entry removal, and native Promise settlement run uninterruptibly so
 * one caller's cancellation cannot abort work another caller is waiting for.
 * A native Promise schedules each waiter's continuation in its own Worker request
 * context; an Effect Deferred would invoke request-bound callbacks from the
 * leader's context. The Provider adapter's HTTP deadline bounds hung upstream work.
 * Nothing is detached, and the shared value is domain data only (never an HTTP
 * response, database client, transaction, or request-owned resource).
 *
 * @param flight - Leader flight whose Promise joiners await.
 * @param providerRead - Cold Provider Effect bound to this leader's service.
 * @returns Leader's own result after joiners have been settled.
 */
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

/**
 * Queries one validated Provider account for its current publication requirements.
 *
 * Carries the initiating caller's operation and request correlation into the
 * adapter request context. Adapter failures map to the established API error
 * envelopes through providerFailure; unexpected provider failures become 502.
 * The Effect is cold and resolves domain data only, so a coalescing leader can
 * run it once and share its outcome without exposing caller-owned resources.
 *
 * @param account - Account row validated under the caller's tenant transaction.
 * @param accessToken - Decrypted provider credential for this caller's read.
 * @param requestId - Correlation ID of the request that initiated the read.
 * @returns Effect resolving to Provider publication requirements.
 */
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

/**
 * Fetches dynamic publication requirements and constraints for a connected platform account as an Effect.
 *
 * Each caller independently queries the Platform account under tenant RLS, checks
 * connection status and token validity, verifies adapter availability, and decrypts
 * its current stored credential before any sharing occurs. Equivalent concurrent
 * callers then join one pending Provider read, keyed by deployment/configuration,
 * authorized identity and Workspace, account, platform, and persisted connection
 * generation. Joiners never bypass their own persisted checks.
 *
 * Only pending work is retained: the entry is removed before its outcome becomes
 * observable, so a subsequent request performs a fresh Provider read. At most 32
 * distinct keys are retained per configuration namespace; an existing key still
 * joins at capacity and a new key beyond it uses the normal uncached path.
 * The leader's read, entry removal, and waiter settlement are uninterruptible, so
 * one caller's cancellation cannot abort work another caller needs; the adapter's
 * bounded HTTP deadline remains the operation deadline. The initiating caller's
 * request ID is the Provider correlation for the shared attempt, while each HTTP
 * response keeps its own request ID at the route boundary. Credentials, request
 * IDs, and HTTP responses are never part of the shared value or key material.
 *
 * Structured provider failures map to the established CoreApiError envelopes via
 * providerFailure(). Unexpected provider failures map to 502 and decrypt failures
 * to 503; database failures remain typed DatabaseError. The account lookup composes
 * an Effect tenant transaction, with ProviderService supplied at the route boundary
 * and no nested runners.
 *
 * @param env - Worker environment bindings containing token encryption key.
 * @param session - Authenticated session claims scoping tenant access.
 * @param accountId - Platform account UUID.
 * @param requestId - Trace request ID for downstream provider calls.
 * @param registry - Provider registry containing platform adapter instances.
 * @param now - Optional reference timestamp for testing token validity.
 * @returns Effect resolving to the upstream publication requirements object.
 */
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
        // Acquisition and leader settlement share one interruption mask, so an
        // abort between them cannot strand a published pending entry.
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
