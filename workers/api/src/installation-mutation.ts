import type { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";
import { withSystemTransactionEffect } from "./database";
import { withIdempotentMutationStatus } from "./idempotent-mutation";

export function idempotentInstallationMutation(
  env: ApiWorkerEnv,
  organizationId: string,
  operation: string,
  key: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<{ body: unknown; status: number }, CoreApiError | DatabaseError>,
): Effect.Effect<
  { body: unknown; replayed: boolean; status: number },
  CoreApiError | DatabaseError
> {
  return withSystemTransactionEffect(env, (client) =>
    withIdempotentMutationStatus(client, organizationId, operation, key, requestHash, run),
  );
}
