import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { isoDateTime, type DatabaseError } from "@meltiply/domain";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import { jsonResponse } from "./responses";
import { idempotencyKey, jsonBody, onlyKeys } from "./validation";
import { idempotentInstallationMutation } from "./installation-mutation";

interface OnboardingProgress {
  completed_at: string | null;
  step: "improvement" | "ready";
  status: "completed" | "in_progress" | "not_applicable";
  workspace_name: string | null;
  workspace_named: boolean;
}

interface OnboardingRow extends Record<string, unknown> {
  completed_at: Date | string | null;
  progress_step: "improvement" | "ready";
  workspace_name: string;
  workspace_named: boolean | null;
}

function onboardingProgressEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
): Effect.Effect<OnboardingProgress, DatabaseError> {
  return client
    .query<OnboardingRow>(
      `SELECT o.name AS workspace_name, ob.workspace_named, ob.completed_at,
              ob.progress_step
       FROM organizations o
       LEFT JOIN installation_onboarding ob ON ob.org_id = o.id
       WHERE o.id = $1`,
      [actor.workspace.id],
    )
    .pipe(
      Effect.map((result) => {
        const row = result.rows[0];
        if (!row) {
          return {
            completed_at: null,
            step: "improvement",
            status: "not_applicable",
            workspace_name: null,
            workspace_named: false,
          } satisfies OnboardingProgress;
        }
        if (row.completed_at !== null) {
          return {
            completed_at: isoDateTime(row.completed_at),
            step: row.progress_step,
            status: "completed",
            workspace_name: row.workspace_name,
            workspace_named: row.workspace_named === true,
          } satisfies OnboardingProgress;
        }
        return {
          completed_at: null,
          step: row.progress_step,
          status: row.workspace_named === null ? "not_applicable" : "in_progress",
          workspace_name: row.workspace_name,
          workspace_named: row.workspace_named === true,
        } satisfies OnboardingProgress;
      }),
    );
}

function requireCurrentOwner(actor: ResolvedActor): Effect.Effect<void, CoreApiError> {
  if (!actor.isInstallationOwner) {
    return Effect.fail(
      new CoreApiError(
        403,
        "installation_owner_required",
        "The installation owner role is required.",
      ),
    );
  }
  return Effect.void;
}

function lockOnboardingRow(
  client: EffectTransactionClient,
  actor: ResolvedActor,
): Effect.Effect<
  { completed_at: Date | string | null; workspace_named: boolean },
  CoreApiError | DatabaseError
> {
  return client
    .query<{ completed_at: Date | string | null; workspace_named: boolean }>(
      `SELECT completed_at, workspace_named FROM installation_onboarding
       WHERE org_id = $1 FOR UPDATE`,
      [actor.workspace.id],
    )
    .pipe(
      Effect.flatMap((result) => {
        const row = result.rows[0];
        return row
          ? Effect.succeed(row)
          : Effect.fail(
              new CoreApiError(
                409,
                "onboarding_not_applicable",
                "This installation was not set up through onboarding; use workspace settings.",
              ),
            );
      }),
    );
}

function saveOnboardingStepEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
  step: "improvement" | "ready",
): Effect.Effect<OnboardingProgress, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const progress = yield* lockOnboardingRow(client, actor);
    if (progress.completed_at !== null) {
      return yield* Effect.fail(
        new CoreApiError(409, "onboarding_complete", "Onboarding is already complete."),
      );
    }
    yield* client.query(
      `UPDATE installation_onboarding
       SET progress_step = $2, updated_at = now()
       WHERE org_id = $1
         AND progress_step IS DISTINCT FROM $2
         AND ($2 = 'ready' OR progress_step = 'improvement')`,
      [actor.workspace.id, step],
    );
    return yield* onboardingProgressEffect(client, actor);
  });
}

function completeOnboardingEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
): Effect.Effect<OnboardingProgress, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    yield* lockOnboardingRow(client, actor);
    yield* client.query(
      `UPDATE installation_onboarding
       SET completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE org_id = $1`,
      [actor.workspace.id],
    );
    return yield* onboardingProgressEffect(client, actor);
  });
}

function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}

export function registerOnboardingRoutes(app: Hono<ApiWorkerEnvironment>): void {
  app.get("/api/v1/onboarding", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireCurrentOwner(actor);
        const progress = yield* withSystemTransactionEffect(c.env, (client) =>
          onboardingProgressEffect(client, actor),
        );
        return jsonResponse(progress, 200, requestId(c));
      }),
    ),
  );

  app.patch("/api/v1/onboarding", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireCurrentOwner(actor);
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["step"]));
        const step = yield* fromPromise(() => {
          if (body.step !== "improvement" && body.step !== "ready") {
            throw new CoreApiError(
              400,
              "validation_error",
              "step must be `improvement` or `ready`.",
            );
          }
          return body.step;
        });
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ step }));
        const result = yield* idempotentInstallationMutation(
          c.env,
          actor.workspace.id,
          "installation.onboarding.save",
          key,
          requestHash,
          (client) =>
            Effect.map(saveOnboardingStepEffect(client, actor, step), (body) => ({
              body,
              replayed: false,
              status: 200,
            })),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/onboarding/complete", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireCurrentOwner(actor);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({}));
        const result = yield* idempotentInstallationMutation(
          c.env,
          actor.workspace.id,
          "installation.onboarding.complete",
          key,
          requestHash,
          (client) =>
            Effect.map(completeOnboardingEffect(client, actor), (body) => ({
              body,
              replayed: false,
              status: 200,
            })),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
}
