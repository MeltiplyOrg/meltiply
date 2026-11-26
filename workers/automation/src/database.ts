import type { Effect } from "effect";
import {
  createHyperdrivePoolCache,
  withTransactionEffect,
  type EffectTransactionClient,
  type Pool,
} from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { AutomationEnv } from "./env";

const resolveSystemPool = createHyperdrivePoolCache("system");

export function systemPoolFor(env: AutomationEnv): Pool {
  return resolveSystemPool(env.DB_SYSTEM, env);
}

export function withSystemTransactionEffect<A, E, R>(
  env: AutomationEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withTransactionEffect(systemPoolFor(env), operation);
}

export type { EffectTransactionClient };
