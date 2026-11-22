import type { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";
import { withSystemTransactionEffect } from "./database";
import { withIdempotentMutationStatus } from "./idempotent-mutation";

/**
 * Runs one idempotent installation mutation inside one system transaction.
 *
 * Installation routes do not carry tenant claims; the workspace id resolved
 * from the actor is re-checked inside the transaction before any write.
 *
 * @param env - Worker environment bindings.
 * @param organizationId - Workspace UUID scoping the idempotency key.
 * @param operation - Operation identifier (e.g. "installation.member.suspend").
 * @param key - Validated Idempotency-Key header value.
 * @param requestHash - SHA-256 digest of the canonical request payload.
 * @param run - Transactional program producing the response status and body.
 * @returns Effect resolving to the fresh or replayed response.
 */
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
