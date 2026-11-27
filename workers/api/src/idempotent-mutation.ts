import type { SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import type { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import type { CoreApiError } from "./api-errors";
import type { IdempotentResult } from "./core-types";
import {
  activeOrganizationIdEffect,
  withSystemTransactionEffect,
  withTenantTransactionEffect,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
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
        replayed: true,
        value: prior.response_body as T,
      };
    }
    const value = yield* run(client);
    yield* completeIdempotencyEffect(
      client,
      organizationId,
      operation,
      idempotencyKey,
      status,
      value,
    );
    return { replayed: false, value };
  });
}

export function withTenantIdempotentMutation<T, E = CoreApiError | DatabaseError>(
  env: ApiWorkerEnv,
  session: SessionClaims,
  operation: string,
  idempotencyKey: string,
  requestPayload: string,
  status: number,
  run: (client: EffectTransactionClient, organizationId: string) => Effect.Effect<T, E>,
  tenantTransaction = withTenantTransactionEffect,
): Effect.Effect<
  IdempotentResult<T>,
  E | ActiveOrganizationRequiredError | CoreApiError | DatabaseError
> {
  return Effect.gen(function* () {
    const requestHash = yield* hashIdempotencyRequestEffect(requestPayload);
    return yield* tenantTransaction(env, session, (client) =>
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

type IdempotentMutationOutcome<Extra extends Record<string, unknown> = Record<never, never>> =
  | { body: unknown; replayed: true; status: number }
  | ({ body: unknown; replayed: false; status: number } & Extra);

export function withIdempotentMutationStatus<
  Extra extends Record<string, unknown> = Record<never, never>,
>(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<{ body: unknown; status: number } & Extra, CoreApiError | DatabaseError>,
): Effect.Effect<IdempotentMutationOutcome<Extra>, CoreApiError | DatabaseError> {
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
        replayed: true as const,
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
    return { ...produced, replayed: false as const };
  });
}

export function idempotentInstallationMutation<
  Extra extends Record<string, unknown> = Record<never, never>,
>(
  env: ApiWorkerEnv,
  organizationId: string,
  operation: string,
  key: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<{ body: unknown; status: number } & Extra, CoreApiError | DatabaseError>,
): Effect.Effect<IdempotentMutationOutcome<Extra>, CoreApiError | DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    withIdempotentMutationStatus(client, organizationId, operation, key, requestHash, run),
  );
}
