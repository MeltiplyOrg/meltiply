import type { Effect } from "effect";
import {
  createHyperdrivePool,
  destroyClientsOnRelease,
  withTransactionEffect,
  type EffectTransactionClient,
  type Pool,
} from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { AutomationEnv } from "./env";

// Module-global pools per managed isolate (AUD-044). Standalone workerd opts
// into request-owned pools so sockets and queued checkouts cannot cross invocations.
let systemPool: Pool | undefined;
let systemConnectionString: string | undefined;

/**
 * Selects a managed-isolate or request-owned PostgreSQL pool for the system Hyperdrive binding.
 *
 * Managed isolates reuse a pool; local or `DATABASE_POOL_MODE=request` calls
 * receive independent pools whose clients close on release.
 *
 * @param env - Automation worker environment containing the DB_SYSTEM Hyperdrive binding.
 * @returns Cached or newly initialized Pool instance.
 * @throws {Error} When the DB_SYSTEM Hyperdrive binding is missing.
 */
export function systemPoolFor(env: AutomationEnv): Pool {
  if (!env.DB_SYSTEM) {
    throw new Error("system Hyperdrive binding is unavailable");
  }
  if (env.ENVIRONMENT === "local" || env.DATABASE_POOL_MODE === "request") {
    return destroyClientsOnRelease(createHyperdrivePool(env.DB_SYSTEM));
  }
  if (!systemPool || systemConnectionString !== env.DB_SYSTEM.connectionString) {
    systemPool = createHyperdrivePool(env.DB_SYSTEM);
    systemConnectionString = env.DB_SYSTEM.connectionString;
  }
  return systemPool;
}

/**
 * Executes an effectful operation within an atomic system database transaction.
 * Delegates to the package's Effect-native transaction API: a pooled client is
 * acquired, BEGIN issued, the operation's Effect evaluated, then COMMIT on
 * success or ROLLBACK on failure; the client is released afterward (destroyed
 * when rollback itself fails). The returned Effect is executed only at the
 * documented Worker runtime boundary (runJobProgram / the recorder's own
 * runPromiseExit leaf), never inside this module.
 *
 * @param env - Automation worker environment with DB_SYSTEM binding.
 * @param operation - Function returning an Effect given the scoped EffectTransactionClient.
 * @returns Effect resolving to the operation result, or failing with the
 *   operation's error or a DatabaseError for acquire/BEGIN/COMMIT failures.
 */
export function withSystemTransactionEffect<A, E, R>(
  env: AutomationEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withTransactionEffect(systemPoolFor(env), operation);
}

export type { EffectTransactionClient };
