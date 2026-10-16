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

// Module-global pool per isolate (AUD-044): Hyperdrive connection strings are
// stable for the isolate's lifetime and pg reconnects internally, so caching
// the pool here is safe and avoids rebuilding it per invocation.
let systemPool: Pool | undefined;
let systemConnectionString: string | undefined;

/**
 * Returns or initializes the isolate-level PostgreSQL connection pool for the system Hyperdrive binding.
 * Deployed isolates reuse a pool; local invocations receive independent pools
 * whose clients close on release so sockets and queued connects cannot cross
 * workerd request ownership boundaries.
 *
 * @param env - Automation worker environment containing the DB_SYSTEM Hyperdrive binding.
 * @returns Cached or newly initialized database Pool instance.
 * @throws {Error} When the DB_SYSTEM Hyperdrive binding is missing.
 */
export function systemPoolFor(env: AutomationEnv): Pool {
  if (!env.DB_SYSTEM) {
    throw new Error("system Hyperdrive binding is unavailable");
  }
  if (env.ENVIRONMENT === "local") {
    return destroyClientsOnRelease(createHyperdrivePool(env.DB_SYSTEM));
  }
  if (!systemPool || systemConnectionString !== env.DB_SYSTEM.connectionString) {
    const pool = createHyperdrivePool(env.DB_SYSTEM);
    systemPool = pool;
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
