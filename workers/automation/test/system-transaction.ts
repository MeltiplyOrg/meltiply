import { Effect } from "effect";

import type { Queryable } from "@meltiply/database";

import { withSystemTransactionEffect } from "../src/database";
import type { AutomationEnv } from "../src/env";

/**
 * Runs a Promise-style fixture block inside the Effect system transaction.
 * The Effect client's `query` is unwrapped to a `Queryable` facade so the
 * test's `await client.query(...)` bodies keep their original shape while the
 * transaction lifecycle (BEGIN/COMMIT/ROLLBACK) stays on
 * `withSystemTransactionEffect`.
 */
export function runSystemTransaction<T>(
  env: AutomationEnv,
  operation: (client: Queryable) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          operation({
            query: (text, values) => Effect.runPromise(client.query(text, values)),
          }),
      }),
    ),
  );
}
