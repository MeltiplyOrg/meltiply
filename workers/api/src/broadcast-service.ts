import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError } from "@meltiply/domain";
import { ProviderService, type ProviderBroadcastInfo } from "@meltiply/providers";
import { Effect } from "effect";

import { CoreApiError } from "./api-errors";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import {
  createPostgresBroadcastRepository,
  type BroadcastRepository,
} from "./repositories/broadcast-repository";
import { tokenCipherFor } from "./token-credentials";

export interface BroadcastControlOptions {
  readonly now?: () => Date;
  readonly repository?: BroadcastRepository;
}

export function broadcastControlEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  distributionId: string,
  requestId: string,
  action: { kind: "read" } | { kind: "end"; key: string },
  options: BroadcastControlOptions = {},
): Effect.Effect<
  ProviderBroadcastInfo | { ended: true },
  CoreApiError | DatabaseError,
  ProviderService
> {
  const repository = options.repository ?? createPostgresBroadcastRepository(env, session);
  const now = options.now ?? (() => new Date());
  return Effect.gen(function* () {
    const operation = "broadcast.end";
    const requestHash =
      action.kind === "end" ? yield* hashIdempotencyRequestEffect(distributionId) : "";
    const loaded = yield* repository.loadAndReserve(
      distributionId,
      action.kind === "end" ? { operation, requestHash } : null,
    );
    const row = loaded.row;
    if (!row) {
      return yield* Effect.fail(new CoreApiError(404, "not_found", "The broadcast was not found."));
    }
    if (!["admin", "editor"].includes(row.role)) {
      return yield* Effect.fail(
        new CoreApiError(
          403,
          "forbidden_role",
          "Your Workspace role cannot access encoder credentials.",
        ),
      );
    }
    if (loaded.replay) return { ended: true as const };
    if (!row.provider_operation_id?.startsWith("live:")) {
      return yield* Effect.fail(
        new CoreApiError(422, "invalid_state", "This Distribution is not a live broadcast."),
      );
    }
    if (
      row.revoked_at ||
      !["connected", "expiring"].includes(row.connection_status) ||
      (row.token_expires_at && new Date(row.token_expires_at) <= now())
    ) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "invalid_state",
          "Reconnect this Channel before controlling the broadcast.",
        ),
      );
    }

    const accessToken = yield* Effect.tryPromise({
      catch: () =>
        new CoreApiError(
          503,
          "dependency_unavailable",
          "Platform credentials are temporarily unavailable.",
        ),
      try: () => tokenCipherFor(env).decrypt(row.access_token),
    });
    const provider = yield* ProviderService;
    const credentials = { accessToken, accountId: row.platform_user_id };
    const context = { operationId: `broadcast:${distributionId}`, requestId };
    const lookup = { providerOperationId: row.provider_operation_id };

    if (action.kind === "read") {
      const info = yield* provider
        .getBroadcastInfo(row.platform, context, credentials, lookup)
        .pipe(
          Effect.mapError(
            () =>
              new CoreApiError(
                502,
                "provider_unavailable",
                "The broadcast details could not be retrieved.",
              ),
          ),
        );
      if (info.providerPostId) {
        yield* repository.markPublishedFromRead({
          distributionId,
          providerPostId: info.providerPostId,
          providerUrl: info.providerUrl ?? null,
        });
      }
      return info;
    }

    const ended = yield* provider
      .endBroadcast(row.platform, context, credentials, lookup)
      .pipe(
        Effect.mapError(
          () =>
            new CoreApiError(
              502,
              "provider_unavailable",
              "The end request could not be confirmed. Refresh the broadcast state before trying again.",
            ),
        ),
      );
    if (ended.outcome !== "confirmed_success") {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "needs_reconciliation",
          "The end request is uncertain. Refresh the broadcast state.",
        ),
      );
    }
    yield* repository.completeEnd({
      distributionId,
      operation,
      orgId: row.org_id,
      providerOperationId: ended.providerOperationId ?? row.provider_operation_id,
      providerPostId: ended.providerPostId ?? null,
      providerUrl: ended.providerUrl ?? null,
    });
    return { ended: true as const };
  });
}

export function readBroadcastEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  distributionId: string,
  requestId: string,
  options: BroadcastControlOptions = {},
): Effect.Effect<ProviderBroadcastInfo, CoreApiError | DatabaseError, ProviderService> {
  return broadcastControlEffect(
    env,
    session,
    distributionId,
    requestId,
    { kind: "read" },
    options,
  ).pipe(Effect.map((result) => result as ProviderBroadcastInfo));
}

export function endBroadcastEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  distributionId: string,
  requestId: string,
  options: BroadcastControlOptions = {},
): Effect.Effect<{ ended: true }, CoreApiError | DatabaseError, ProviderService> {
  return broadcastControlEffect(
    env,
    session,
    distributionId,
    requestId,
    { key: distributionId, kind: "end" },
    options,
  ).pipe(Effect.map((result) => result as { ended: true }));
}
