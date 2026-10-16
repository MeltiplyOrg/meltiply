import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import {
  createHyperdrivePool,
  destroyClientsOnRelease,
  withAuthenticatedTransactionEffect,
  withTransactionEffect,
  type EffectTransactionClient,
  type Pool,
} from "@meltiply/database";

import { AccessDenied, DatabaseError } from "@meltiply/domain";

import type { ApiWorkerEnv } from "./env";

// Deployed isolates retain pools per Hyperdrive connection string (AUD-044).
// Local requests must not reuse another request's socket or queued checkout.
let authenticatedPool: Pool | undefined;
let authenticatedConnectionString: string | undefined;
let systemPool: Pool | undefined;
let systemConnectionString: string | undefined;

/**
 * Manages caching and instantiation of Hyperdrive connection pools for an isolate.
 *
 * Deployed isolates reuse a pool while the connection string is unchanged.
 * Local invocations get independent pools whose clients close on release:
 * workerd owns sockets and queued connects per request, so sharing a busy
 * pool can strand a later request even without an idle connection.
 *
 * @param binding - Cloudflare Hyperdrive binding instance.
 * @param currentPool - Previously cached Pool instance in this isolate, if any.
 * @param currentConnectionString - Previously cached connection string.
 * @param label - Descriptive pool identifier used for error reporting (e.g., `"authenticated"`).
 * @param env - Worker environment bindings.
 * @returns Object containing the active connection string and initialized `Pool`.
 * @throws {Error} If the specified Hyperdrive binding is undefined.
 */
function poolFor(
  binding: Hyperdrive | undefined,
  currentPool: Pool | undefined,
  currentConnectionString: string | undefined,
  label: string,
  env: ApiWorkerEnv,
): { connectionString: string; pool: Pool } {
  if (!binding) throw new Error(`${label} Hyperdrive binding is unavailable`);
  if (env.ENVIRONMENT === "local") {
    return {
      connectionString: binding.connectionString,
      pool: destroyClientsOnRelease(createHyperdrivePool(binding)),
    };
  }
  if (!currentPool || currentConnectionString !== binding.connectionString) {
    const pool = createHyperdrivePool(binding);
    return {
      connectionString: binding.connectionString,
      pool,
    };
  }
  return { connectionString: currentConnectionString, pool: currentPool };
}

/**
 * Returns the PostgreSQL pool for tenant-authenticated queries.
 *
 * Connects via the `DB_AUTHENTICATED` Hyperdrive binding where Row Level Security (RLS) is
 * enforced based on session claims. Local calls create independent pools;
 * deployed calls reuse the isolate cache while the binding is unchanged.
 *
 * @param env - Worker environment bindings containing `DB_AUTHENTICATED`.
 * @returns Cached or newly initialized `Pool` for authenticated transactions.
 */
export function authenticatedPoolFor(env: ApiWorkerEnv): Pool {
  const next = poolFor(
    env.DB_AUTHENTICATED,
    authenticatedPool,
    authenticatedConnectionString,
    "authenticated",
    env,
  );
  authenticatedPool = next.pool;
  authenticatedConnectionString = next.connectionString;
  return next.pool;
}

/**
 * Returns the PostgreSQL pool for system/administrative queries.
 *
 * Connects via the `DB_SYSTEM` Hyperdrive binding for privileged background operations,
 * webhook processing, and tenant setup that bypass standard tenant RLS boundaries.
 * Local calls create independent pools; deployed calls reuse the isolate cache.
 *
 * @param env - Worker environment bindings containing `DB_SYSTEM`.
 * @returns Cached or newly initialized `Pool` for system transactions.
 */
export function systemPoolFor(env: ApiWorkerEnv): Pool {
  const next = poolFor(env.DB_SYSTEM, systemPool, systemConnectionString, "system", env);
  systemPool = next.pool;
  systemConnectionString = next.connectionString;
  return next.pool;
}

/**
 * Executes an effectful callback within a tenant-scoped database transaction configured with actor claims.
 *
 * Delegates to `withAuthenticatedTransactionEffect`, which serializes verified claims into a single
 * transaction-local PostgreSQL setting (`request.jwt.claims`) via `set_config(..., true)`.
 * The `is_local=true` flag scopes the setting to the current transaction, so it is invisible
 * to other transactions sharing the same pooled connection. A 10-second `statement_timeout`
 * is applied in the same scope to protect against unbounded queries.
 *
 * The claims must come from `ResolvedActor.claims` produced by actor resolution: `sub` is the
 * Better Auth subject, `org_id` the internal workspace UUID, and `org_role` the authoritative
 * `org_members` role. Identity binding and personal-workspace provisioning happen during
 * actor resolution, never inside tenant transactions.
 *
 * @param env - Worker environment bindings.
 * @param claims - Verified actor claims carrying the auth subject and resolved workspace context.
 * @param operation - Function returning an Effect given the scoped `EffectTransactionClient`.
 * @returns Effect resolving to the operation result or failing with DatabaseError or operation error.
 */
export function withTenantTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  claims: SessionClaims,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withAuthenticatedTransactionEffect(
    authenticatedPoolFor(env),
    {
      ...(claims.organizationId ? { org_id: claims.organizationId } : {}),
      org_role: claims.organizationRole,
      sub: claims.subject,
    },
    operation,
  ).pipe(
    Effect.catchTag("InvalidRequestError", (err) =>
      Effect.fail(
        new DatabaseError({
          cause: err,
          message:
            typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Invalid database request",
        }),
      ),
    ),
  );
}

/**
 * Executes an effectful callback within an unconstrained system-level database transaction.
 *
 * Uses the privileged `DB_SYSTEM` pool to perform cross-tenant operations, webhook ingest,
 * or background processing without tenant RLS scoping.
 *
 * @param env - Worker environment bindings.
 * @param operation - Function returning an Effect given the privileged `EffectTransactionClient`.
 * @returns Effect resolving to the operation result or failing with DatabaseError.
 */
export function withSystemTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withTransactionEffect(systemPoolFor(env), operation);
}

/**
 * Resolve the RLS-active organization id inside an authenticated Effect transaction.
 *
 * Defense-in-depth check confirming the database agrees the caller is an active member.
 *
 * @param client - Active tenant-scoped EffectTransactionClient.
 * @returns Effect resolving to the active organization UUID string or failing with AccessDenied.
 */
export function activeOrganizationIdEffect(
  client: EffectTransactionClient,
): Effect.Effect<string, AccessDenied | DatabaseError> {
  return client.query<{ id: string }>("SELECT public.auth_active_org_id()::text AS id").pipe(
    Effect.flatMap((result) => {
      const id = result.rows[0]?.id;
      if (!id) {
        return Effect.fail(
          new AccessDenied("The authenticated identity is not an active organization member."),
        );
      }
      return Effect.succeed(id);
    }),
  );
}

export type { EffectTransactionClient };
