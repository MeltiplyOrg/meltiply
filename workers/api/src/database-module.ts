import type { EffectTransactionClient, Pool } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import type * as DatabaseModuleNamespace from "./database";
import type { ApiWorkerEnv } from "./env";

type DatabaseModule = typeof DatabaseModuleNamespace;

// pg cannot evaluate at module load inside workerd unit-test isolates without a database binding.
function loadDatabaseModule(): Promise<DatabaseModule> {
  return import("./database");
}

export async function lazySystemPoolFor(env: ApiWorkerEnv): Promise<Pool> {
  const { systemPoolFor } = await loadDatabaseModule();
  return systemPoolFor(env);
}

export async function lazyAuthenticatedPoolFor(env: ApiWorkerEnv): Promise<Pool> {
  const { authenticatedPoolFor } = await loadDatabaseModule();
  return authenticatedPoolFor(env);
}

export function lazyWithSystemTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return Effect.flatMap(Effect.promise(loadDatabaseModule), ({ withSystemTransactionEffect }) =>
    withSystemTransactionEffect(env, operation),
  );
}
