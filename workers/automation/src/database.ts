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

// Entry boundaries clone bindings per invocation; weak keys never retain an
// invocation's empty driver adapter after its work and continuations finish.
const invocationPools = new WeakMap<AutomationEnv, { connectionString: string; pool: Pool }>();

/**
 * Returns the invocation-owned PostgreSQL adapter for system transactions.
 * Released clients close instead of crossing Worker I/O ownership; Hyperdrive
 * retains its independent origin pool. Four clients bound local concurrency.
 *
 * @param env - Automation worker environment containing the DB_SYSTEM Hyperdrive binding.
 * @returns Cached or newly initialized database Pool instance.
 * @throws {Error} When the DB_SYSTEM Hyperdrive binding is missing.
 */
export function systemPoolFor(env: AutomationEnv): Pool {
  if (!env.DB_SYSTEM) {
    throw new Error("system Hyperdrive binding is unavailable");
  }
  const previous = invocationPools.get(env);
  if (previous?.connectionString === env.DB_SYSTEM.connectionString) return previous.pool;
  const pool = destroyClientsOnRelease(createHyperdrivePool(env.DB_SYSTEM, { max: 4 }));
  invocationPools.set(env, { connectionString: env.DB_SYSTEM.connectionString, pool });
  return pool;
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
