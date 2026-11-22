import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import {
  createHyperdrivePoolCache,
  withAuthenticatedTransactionEffect,
  withTransactionEffect,
  type EffectTransactionClient,
  type Pool,
} from "@meltiply/database";

import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";

import type { ApiWorkerEnv } from "./env";

const resolveAuthenticatedPool = createHyperdrivePoolCache("authenticated");
const resolveSystemPool = createHyperdrivePoolCache("system");

export function authenticatedPoolFor(env: ApiWorkerEnv): Pool {
  return resolveAuthenticatedPool(env.DB_AUTHENTICATED, env);
}

export function systemPoolFor(env: ApiWorkerEnv): Pool {
  return resolveSystemPool(env.DB_SYSTEM, env);
}

export function withTenantTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  claims: SessionClaims,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withAuthenticatedTransactionEffect(
    authenticatedPoolFor(env),
    {
      ...(claims.organizationId ? { org_id: claims.organizationId } : {}),
      org_role: claims.organizationRole,
      sub: claims.subject,
    },
    operation,
  ).pipe(
    Effect.catchTag("InvalidRequestError", (err) =>
      Effect.fail(
        new DatabaseError({
          cause: err,
          message:
            typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Invalid database request",
        }),
      ),
    ),
  );
}

export function withSystemTransactionEffect<A, E, R>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return withTransactionEffect(systemPoolFor(env), operation);
}

export function activeOrganizationIdEffect(
  client: EffectTransactionClient,
): Effect.Effect<string, ActiveOrganizationRequiredError | DatabaseError> {
  return client.query<{ id: string }>("SELECT public.auth_active_org_id()::text AS id").pipe(
    Effect.flatMap((result) => {
      const id = result.rows[0]?.id;
      if (!id) {
        return Effect.fail(
          new ActiveOrganizationRequiredError({
            message: "The authenticated identity is not an active organization member.",
          }),
        );
      }
      return Effect.succeed(id);
    }),
  );
}

export type { EffectTransactionClient };
