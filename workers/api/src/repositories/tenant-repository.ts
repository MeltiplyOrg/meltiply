import type { SessionClaims } from "@meltiply/auth";
import type { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import type { CoreApiError, IdempotentResult } from "../core-types";
import type { ApiWorkerEnv } from "../env";
import {
  hashIdempotencyRequestEffect,
  idempotentMutation,
  type IdempotencyLedger,
} from "../idempotency";

export interface TenantTransaction extends IdempotencyLedger {
  activeOrganizationId(): Effect.Effect<string, ActiveOrganizationRequiredError | DatabaseError>;
  activeRole(): Effect.Effect<string | null, DatabaseError>;
  lockOrganization(organizationId: string): Effect.Effect<void, DatabaseError>;
  requireActiveBrandProfile(
    organizationId: string,
    brandProfileId: string,
  ): Effect.Effect<void, CoreApiError | DatabaseError>;
  timezoneExists(timezone: string): Effect.Effect<boolean, DatabaseError>;
}

export interface TenantRepository<Transaction extends TenantTransaction> {
  transaction<Value, Failure>(
    session: SessionClaims,
    work: (tx: Transaction) => Effect.Effect<Value, Failure>,
  ): Effect.Effect<Value, Failure | DatabaseError>;
}

export type TenantRepositoryProvider<Transaction extends TenantTransaction> = (
  env: ApiWorkerEnv,
) => TenantRepository<Transaction>;

export function tenantIdempotentMutation<Transaction extends TenantTransaction, Value, Failure>(
  repository: TenantRepository<Transaction>,
  session: SessionClaims,
  operation: string,
  idempotencyKey: string,
  requestPayload: string,
  status: number,
  run: (tx: Transaction, organizationId: string) => Effect.Effect<Value, Failure>,
): Effect.Effect<
  IdempotentResult<Value>,
  Failure | ActiveOrganizationRequiredError | CoreApiError | DatabaseError
> {
  return Effect.gen(function* () {
    const requestHash = yield* hashIdempotencyRequestEffect(requestPayload);
    return yield* repository.transaction(session, (tx) =>
      Effect.gen(function* () {
        const organizationId = yield* tx.activeOrganizationId();
        return yield* idempotentMutation(
          tx,
          organizationId,
          operation,
          idempotencyKey,
          requestHash,
          status,
          () => run(tx, organizationId),
        );
      }),
    );
  });
}
