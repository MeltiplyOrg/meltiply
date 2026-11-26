import type { SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import type { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import type { CoreApiError, IdempotentResult } from "./core-types";
import { activeOrganizationIdEffect, withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  clientIdempotencyLedger,
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  idempotentMutation,
  reserveIdempotencyEffect,
} from "./idempotency";

export function withIdempotentMutation<T, E = CoreApiError | DatabaseError>(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  status: number,
  run: (client: EffectTransactionClient) => Effect.Effect<T, E>,
): Effect.Effect<IdempotentResult<T>, E | CoreApiError | DatabaseError> {
  return idempotentMutation(
    clientIdempotencyLedger(client),
    organizationId,
    operation,
    idempotencyKey,
    requestHash,
    status,
    () => run(client),
  );
}

export function withTenantIdempotentMutation<T, E = CoreApiError | DatabaseError>(
  env: ApiWorkerEnv,
  session: SessionClaims,
  operation: string,
  idempotencyKey: string,
  requestPayload: string,
  status: number,
  run: (client: EffectTransactionClient, organizationId: string) => Effect.Effect<T, E>,
): Effect.Effect<
  IdempotentResult<T>,
  E | ActiveOrganizationRequiredError | CoreApiError | DatabaseError
> {
  return Effect.gen(function* () {
    const requestHash = yield* hashIdempotencyRequestEffect(requestPayload);
    return yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const organizationId = yield* activeOrganizationIdEffect(client);
        return yield* withIdempotentMutation(
          client,
          organizationId,
          operation,
          idempotencyKey,
          requestHash,
          status,
          (tx) => run(tx, organizationId),
        );
      }),
    );
  });
}

export function withIdempotentMutationStatus(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<{ body: unknown; status: number }, CoreApiError | DatabaseError>,
): Effect.Effect<
  { body: unknown; replayed: boolean; status: number },
  CoreApiError | DatabaseError
> {
  return Effect.gen(function* () {
    const prior = yield* reserveIdempotencyEffect(
      client,
      organizationId,
      operation,
      idempotencyKey,
      requestHash,
    );
    if (prior) {
      return {
        body: prior.response_body,
        replayed: true,
        status: prior.response_status ?? 200,
      };
    }
    const produced = yield* run(client);
    yield* completeIdempotencyEffect(
      client,
      organizationId,
      operation,
      idempotencyKey,
      produced.status,
      produced.body,
    );
    return { ...produced, replayed: false };
  });
}
