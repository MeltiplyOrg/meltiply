import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, ActiveOrganizationRequiredError } from "@meltiply/domain";
import { Effect } from "effect";

import {
  createBrandProfilePayload,
  isUniqueViolation,
  restoreError,
  updateBrandProfilePayload,
  workspaceAdminError,
  type BrandProfile,
  type CreateBrandProfileInput,
  type UpdateBrandProfileInput,
} from "./brand-profile-rules";
import { CoreApiError, type IdempotentResult } from "./core-types";
import type { ApiWorkerEnv } from "./env";
import type {
  BrandProfileRepositoryProvider,
  BrandProfileTransaction,
} from "./repositories/brand-profile-repository";
import { postgresBrandProfileRepository } from "./repositories/postgres-brand-profile-repository";
import { tenantIdempotentMutation } from "./repositories/tenant-repository";

export type { BrandProfile, CreateBrandProfileInput, UpdateBrandProfileInput };

export type BrandProfileServiceError =
  | CoreApiError
  | ActiveOrganizationRequiredError
  | DatabaseError;

export interface BrandProfileApiService {
  listBrandProfiles(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<BrandProfile[], BrandProfileServiceError>;
  listDeletedBrandProfiles(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<BrandProfile[], BrandProfileServiceError>;
  getBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
  ): Effect.Effect<BrandProfile, BrandProfileServiceError>;
  createBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: CreateBrandProfileInput,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  updateBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    input: UpdateBrandProfileInput,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  deleteBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  restoreBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
}

function requireWorkspaceAdmin(
  tx: BrandProfileTransaction,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.flatMap(tx.activeRole(), (role) => {
    const rejection = workspaceAdminError(role);
    return rejection ? Effect.fail(rejection) : Effect.void;
  });
}

const profileNotFound = () =>
  new CoreApiError(404, "not_found", "The brand profile was not found.");

function rejectDuplicateName<Value>(write: Effect.Effect<Value, DatabaseError>) {
  return write.pipe(
    Effect.catchIf(isUniqueViolation, () =>
      Effect.fail(
        new CoreApiError(409, "invalid_state", "A brand profile with this name already exists."),
      ),
    ),
  );
}

export function createBrandProfileService({
  now = () => new Date(),
  repository = postgresBrandProfileRepository,
}: {
  now?: () => Date;
  repository?: BrandProfileRepositoryProvider;
} = {}): BrandProfileApiService {
  return {
    listBrandProfiles(env, session) {
      return repository(env).transaction(session, (tx) => tx.activeBrandProfiles());
    },

    listDeletedBrandProfiles(env, session) {
      return repository(env).transaction(session, (tx) =>
        Effect.andThen(requireWorkspaceAdmin(tx), () => tx.deletedBrandProfiles()),
      );
    },

    getBrandProfile(env, session, profileId) {
      return repository(env).transaction(session, (tx) =>
        Effect.flatMap(tx.brandProfile(profileId), (profile) =>
          profile ? Effect.succeed(profile) : Effect.fail(profileNotFound()),
        ),
      );
    },

    createBrandProfile(env, session, input, idempotencyKey) {
      return tenantIdempotentMutation(
        repository(env),
        session,
        "brand-profile.create",
        idempotencyKey,
        createBrandProfilePayload(input),
        201,
        (tx, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdmin(tx);
            return yield* rejectDuplicateName(tx.insertBrandProfile(organizationId, input));
          }),
      );
    },

    updateBrandProfile(env, session, profileId, input, idempotencyKey) {
      return tenantIdempotentMutation(
        repository(env),
        session,
        "brand-profile.update",
        idempotencyKey,
        updateBrandProfilePayload(profileId, input),
        200,
        (tx, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdmin(tx);
            const updated = yield* rejectDuplicateName(
              tx.updateBrandProfile(profileId, organizationId, input),
            );
            if (!updated) return yield* Effect.fail(profileNotFound());
            return updated;
          }),
      );
    },

    deleteBrandProfile(env, session, profileId, idempotencyKey) {
      return tenantIdempotentMutation(
        repository(env),
        session,
        "brand-profile.delete",
        idempotencyKey,
        JSON.stringify({ profile_id: profileId }),
        200,
        (tx, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdmin(tx);
            yield* tx.lockOrganization(organizationId);
            if (!(yield* tx.lockBrandProfileForDeletion(profileId, organizationId))) {
              return yield* Effect.fail(profileNotFound());
            }
            const channels = yield* tx.brandProfileChannels(profileId, organizationId);
            for (const channel of channels) {
              yield* tx.disconnectChannel(organizationId, channel);
            }
            return yield* tx.deleteBrandProfile(profileId, organizationId);
          }),
      );
    },

    restoreBrandProfile(env, session, profileId, idempotencyKey) {
      return tenantIdempotentMutation(
        repository(env),
        session,
        "brand-profile.restore",
        idempotencyKey,
        JSON.stringify({ profile_id: profileId }),
        200,
        (tx, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdmin(tx);
            const retention = yield* tx.lockBrandProfileRetention(profileId, organizationId);
            if (!retention) return yield* Effect.fail(profileNotFound());
            const rejection = restoreError(retention, now());
            if (rejection) return yield* Effect.fail(rejection);
            return yield* tx.restoreBrandProfile(profileId, organizationId);
          }),
      );
    },
  };
}
