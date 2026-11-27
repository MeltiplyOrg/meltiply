import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import { CoreApiError } from "./api-errors";
import { type IdempotentResult } from "./core-types";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect, idempotentMutation } from "./idempotency";
import type { PostServiceError } from "./post-types";
import {
  emailDeliveryAvailable,
  mapPreferences,
  preferencesError,
  validatedPreferences,
} from "./publishing-preferences-rules";
import { postgresPublishingPreferencesRepository } from "./repositories/postgres-publishing-preferences-repository";
import type { PublishingPreferencesRepositoryProvider } from "./repositories/publishing-preferences-repository";
import { requireSupportedTimezone } from "./repositories/tenant-repository";

type Schemas = components["schemas"];

type PublishingPreferencesUpdate = Schemas["PublishingPreferencesUpdate"];

export interface PublishingPreferencesApiService {
  get(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<Schemas["PublishingPreferences"], PostServiceError>;
  replace(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: PublishingPreferencesUpdate,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<Schemas["PublishingPreferences"]>, PostServiceError>;
}

export function createPublishingPreferencesApiService({
  repository = postgresPublishingPreferencesRepository,
}: {
  repository?: PublishingPreferencesRepositoryProvider;
} = {}): PublishingPreferencesApiService {
  return {
    get(env, session) {
      return repository(env).transaction(session, (tx) =>
        Effect.map(tx.preferences(), (row) => mapPreferences(row, emailDeliveryAvailable(env))),
      );
    },

    replace(env, session, input, idempotencyKey) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify(input));
        return yield* repository(env).transaction(session, (tx) =>
          Effect.gen(function* () {
            const organizationId = yield* tx.activeOrganizationId();
            if ((yield* tx.activeRole()) !== "admin") {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "workspace_admin_required",
                  "Only Workspace Admins can change publishing preferences.",
                ),
              );
            }
            return yield* idempotentMutation<Schemas["PublishingPreferences"], PostServiceError>(
              tx,
              organizationId,
              "publishing-preferences",
              idempotencyKey,
              requestHash,
              200,
              () =>
                Effect.gen(function* () {
                  if (input.timezone !== null) {
                    yield* requireSupportedTimezone(tx, input.timezone);
                  }
                  const emailAvailable = emailDeliveryAvailable(env);
                  const validated = yield* Effect.try({
                    catch: preferencesError,
                    try: () => validatedPreferences(input, emailAvailable),
                  });
                  const saved = yield* tx.savePreferences(organizationId, {
                    ...validated,
                    timezone: input.timezone,
                  });
                  return mapPreferences(saved, emailAvailable);
                }),
            );
          }),
        );
      });
    },
  };
}
