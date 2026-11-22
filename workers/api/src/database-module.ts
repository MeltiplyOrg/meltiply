import type { EffectTransactionClient, Pool } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import type * as DatabaseModuleNamespace from "./database";
import type { ApiWorkerEnv } from "./env";

type DatabaseModule = typeof DatabaseModuleNamespace;

/**
 * Loads `./database` dynamically on demand.
 *
 * `pg` cannot be evaluated at module-load time inside workerd unit-test isolates
 * that do not bind a database, so every caller that must stay importable without
 * `pg` crosses this single lazy seam instead of repeating dynamic imports.
 *
 * @returns The loaded `./database` module.
 */
function loadDatabaseModule(): Promise<DatabaseModule> {
  return import("./database");
}

/**
 * Resolves the system PostgreSQL pool lazily without statically importing `pg`.
 *
 * @param env - Worker environment containing `DB_SYSTEM`.
 * @returns Active system `Pool`.
 */
export async function lazySystemPoolFor(env: ApiWorkerEnv): Promise<Pool> {
  const { systemPoolFor } = await loadDatabaseModule();
  return systemPoolFor(env);
}

/**
 * Resolves the authenticated PostgreSQL pool lazily without statically importing `pg`.
 *
 * @param env - Worker environment containing `DB_AUTHENTICATED`.
 * @returns Active authenticated `Pool`.
 */
export async function lazyAuthenticatedPoolFor(env: ApiWorkerEnv): Promise<Pool> {
  const { authenticatedPoolFor } = await loadDatabaseModule();
  return authenticatedPoolFor(env);
}

/**
 * Executes an Effect inside a system database transaction via the lazy seam.
 *
 * @param env - Worker environment containing `DB_SYSTEM`.
 * @param operation - Transactional Effect receiving a system `EffectTransactionClient`.
 * @returns Effect resolving to the operation result or failing with `E | DatabaseError`.
 */
export function lazyWithSystemTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return Effect.flatMap(Effect.promise(loadDatabaseModule), ({ withSystemTransactionEffect }) =>
    withSystemTransactionEffect(env, operation),
  );
}
