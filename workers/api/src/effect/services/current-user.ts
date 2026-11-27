import { Context, Effect, Layer } from "effect";
import { ActiveOrganizationRequiredError, DatabaseError, errorMessage } from "@meltiply/domain";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";

import type { ApiWorkerEnv } from "../../env";

type UserProfile = components["schemas"]["UserProfile"];

interface CurrentUserServiceShape {
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
    getCurrentUser: () => {
      const loadEffect: Effect.Effect<
        UserProfile | null,
        ActiveOrganizationRequiredError | DatabaseError
      > = loader
        ? Effect.tryPromise({
            catch: (cause) =>
              new DatabaseError({
                cause,
                message: errorMessage(cause, "Failed to query current user"),
              }),
            try: () => loader(env, claims),
          })
        : Effect.tryPromise({
            catch: (cause) =>
              new DatabaseError({
                cause,
                message: errorMessage(cause, "Failed to query current user"),
              }),
            try: () => import("../../current-user"),
          }).pipe(Effect.flatMap((mod) => mod.loadCurrentUserEffect(env, claims)));

      return loadEffect.pipe(
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
      );
    },
  };

  return Layer.succeed(CurrentUserService, service);
}
