import { Context, Effect, Layer } from "effect";
import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";

import type { ApiWorkerEnv } from "../../env";

type UserProfile = components["schemas"]["UserProfile"];

/**
 * Service shape describing the current user application boundary.
 */
export interface CurrentUserServiceShape {
  readonly getCurrentUser: () => Effect.Effect<
    UserProfile,
    ActiveOrganizationRequiredError | DatabaseError,
    never
  >;
}

/**
 * Effect service tag for loading the current authenticated user profile and active tenant context.
 */
export class CurrentUserService extends Context.Service<
  CurrentUserService,
  CurrentUserServiceShape
>()("CurrentUserService") {}

/**
 * Creates a test Layer providing a stubbed or fake CurrentUserService implementation.
 *
 * Replaces ad-hoc global mocking with structured Effect dependency injection for unit tests.
 *
 * @param impl - Optional partial implementation overrides.
 * @returns Layer providing the configured CurrentUserService.
 */
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

/**
 * Creates a live production Layer for CurrentUserService backed by PostgreSQL and tenant claims.
 *
 * Executes the tenant-scoped database query within a transaction configured for the caller's identity,
 * wrapping the database load operation in an observable Effect span with tenant correlation attributes.
 *
 * @param env - Cloudflare Worker environment bindings containing database connection and Hyperdrive config.
 * @param claims - Authenticated actor claims identifying the Better Auth subject, internal user, and resolved workspace.
 * @param loader - Optional custom user loader override, defaulting to the dynamic current-user module.
 * @returns Layer providing the production CurrentUserService.
 */
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
