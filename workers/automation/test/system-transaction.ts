import { Effect } from "effect";

import type { Queryable } from "@meltiply/database";

import { withSystemTransactionEffect } from "../src/database";
import type { AutomationEnv } from "../src/env";

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
