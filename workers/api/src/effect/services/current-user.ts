import { Context, Effect, Layer } from "effect";
import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";

import type { ApiWorkerEnv } from "../../env";

type UserProfile = components["schemas"]["UserProfile"];

export interface CurrentUserServiceShape {
  readonly getCurrentUser: () => Effect.Effect<
    UserProfile,
    ActiveOrganizationRequiredError | DatabaseError,
    never
  >;
}

export class CurrentUserService extends Context.Service<
  CurrentUserService,
  CurrentUserServiceShape
>()("CurrentUserService") {}

export function createCurrentUserServiceTest(
  impl?: Partial<CurrentUserServiceShape>,
): Layer.Layer<CurrentUserService, never, never> {
  const service: CurrentUserServiceShape = {
    getCurrentUser:
      impl?.getCurrentUser ??
      (() =>
        Effect.fail(
          new ActiveOrganizationRequiredError({
            message: "The authenticated identity is not an active organization member.",
          }),
        )),
  };

  return Layer.succeed(CurrentUserService, service);
}

export function createCurrentUserServiceLive(
  env: ApiWorkerEnv,
  claims: SessionClaims,
  loader?: (env: ApiWorkerEnv, claims: SessionClaims) => Promise<UserProfile | null>,
): Layer.Layer<CurrentUserService, never, never> {
  const service: CurrentUserServiceShape = {
    getCurrentUser: () =>
      Effect.tryPromise({
        catch: (cause) =>
          new DatabaseError({
            cause,
            message: cause instanceof Error ? cause.message : "Failed to query current user",
          }),
        try: async () => {
          if (loader) {
            return loader(env, claims);
          }
          const currentUserModule = await import("../../current-user");
          return currentUserModule.loadCurrentUser(env, claims);
        },
      }).pipe(
        Effect.flatMap((user) => {
          if (!user) {
            return Effect.fail(
              new ActiveOrganizationRequiredError({
                message: "The authenticated identity is not an active organization member.",
              }),
            );
          }
          return Effect.succeed(user);
        }),
        Effect.withSpan("current_user.load", {
          attributes: {
            "organization.id": claims.organizationId ?? "",
            "user.id": claims.subject,
          },
        }),
      ),
  };

  return Layer.succeed(CurrentUserService, service);
}
