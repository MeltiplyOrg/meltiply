import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { isoDateTime, type DatabaseError } from "@meltiply/domain";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import { jsonResponse } from "./responses";
import { idempotencyKey, jsonBody, onlyKeys, stringField, workspaceNameValue } from "./validation";
import { idempotentMutation } from "./workspace-lifecycle";

/**
 * First-run onboarding progress for the current Installation Owner.
 *
 * `not_applicable` marks an installation whose canonical Workspace exists
 * without an onboarding record (an upgrade, or an Owner who inherited an
 * already-provisioned installation): its Owner keeps normal sign-in and is
 * never forced through setup. `in_progress` is the resumable state after the
 * first-run account exists and before the final screen completes; `completed`
 * is terminal, so the name is thereafter changed through Workspace settings.
 */
interface OnboardingProgress {
  completed_at: string | null;
  /**
   * Optional screen the current Owner reached. A restart resumes here, and it is
   * stored independently of consent, attribution and terminal completion because
   * skipping or declining must still resume at the same place.
   */
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

/**
 * Reads onboarding progress for the caller's canonical shared Workspace.
 *
 * The reported name is the Workspace's current name, so a Settings rename is
 * reflected immediately; the onboarding row only carries the completion and
 * whether the setup name was settled. Actor resolution creates that row for a
 * bootstrapped Owner, and its absence is what identifies an upgraded
 * installation that must not be pushed back through setup.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved caller.
 * @returns Effect resolving the progress record.
 */
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
          // A missing onboarding row is an upgraded installation, not a
          // journey someone may resume.
          status: row.workspace_named === null ? "not_applicable" : "in_progress",
          workspace_name: row.workspace_name,
          workspace_named: row.workspace_named === true,
        } satisfies OnboardingProgress;
      }),
    );
}

/**
 * Asserts the caller is the current Installation Owner.
 *
 * Ownership is read from the live session on every request, so authority moves
 * with an ownership transfer instead of staying with the account that started
 * setup.
 *
 * @param actor - Resolved request actor.
 * @returns Effect failing with 403 `installation_owner_required` for non-owners.
 */
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

/**
 * Locks the caller's onboarding row and returns it.
 *
 * Save and completion both mutate the same progress record, and completion is
 * terminal: a save that read the row before a concurrent completion committed
 * would otherwise rename the Workspace afterwards, silently overwriting a name
 * the Owner set in Settings. Taking the row lock here is what orders the two, so
 * whichever runs second observes the other's committed state.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved Installation Owner.
 * @returns Effect resolving the locked onboarding row.
 * @throws {CoreApiError} 409 `onboarding_not_applicable` for an upgraded installation.
 */
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

/**
 * Persists the optional screen the Owner reached.
 *
 * Progress is its own fact: it is not inferred from consent, attribution or
 * completion, because skipping and declining are both supported paths that must
 * still resume at the same screen after a restart. The step only ever advances,
 * so a late write from an older tab cannot move the journey backwards.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved Installation Owner.
 * @param step - Screen the Owner is on.
 * @returns Effect resolving the updated progress.
 * @throws {CoreApiError} 409 `onboarding_not_applicable` for an upgraded installation.
 */
function saveOnboardingStepEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
  step: "improvement" | "ready",
): Effect.Effect<OnboardingProgress, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    yield* lockOnboardingRow(client, actor);
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

/**
 * Applies the chosen Workspace name to the canonical shared Workspace.
 *
 * Runs inside the caller's transaction and takes the onboarding row lock first,
 * so a save ordered after completion observes `completed_at` and refuses instead
 * of renaming the Workspace behind Settings. The Workspace row is locked as well,
 * so two concurrent saves serialize on the name they write.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved Installation Owner.
 * @param requestId - Request identifier recorded on the Audit entry.
 * @param name - Trimmed Workspace name to apply.
 * @returns Effect resolving the updated progress.
 */
function saveWorkspaceNameEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
  requestId: string,
  name: string,
): Effect.Effect<OnboardingProgress, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const onboarding = yield* lockOnboardingRow(client, actor);
    if (onboarding.completed_at !== null) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "onboarding_complete",
          "Onboarding is complete; change the workspace name in settings.",
        ),
      );
    }
    const locked = yield* client.query<{ name: string }>(
      "SELECT name FROM organizations WHERE id = $1 FOR UPDATE",
      [actor.workspace.id],
    );
    const current = locked.rows[0]?.name;
    if (current === undefined) {
      return yield* Effect.fail(
        new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
      );
    }
    if (current !== name) {
      yield* client.query("UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1", [
        actor.workspace.id,
        name,
      ]);
      yield* recordWorkspaceAuditEffect(client, {
        action: "workspace.renamed",
        actor: auditActorFrom({
          display_name: actor.displayName,
          email: actor.email,
          id: actor.userId,
        }),
        after: { name },
        before: { name: current },
        orgId: actor.workspace.id,
        requestId,
        targetId: actor.workspace.id,
        targetType: "workspace",
      });
    }
    yield* client.query(
      `UPDATE installation_onboarding
       SET workspace_name = $2, workspace_named = TRUE, updated_at = now()
       WHERE org_id = $1`,
      [actor.workspace.id, name],
    );
    return yield* onboardingProgressEffect(client, actor);
  });
}

/**
 * Marks first-run onboarding complete for the canonical shared Workspace.
 *
 * Completion records nothing else: optional screens, reporting choices, Channel
 * connection, and Invitations stay independent, so a skipped improvement screen
 * or a failed connection cannot block entering the Workspace. It never renames
 * the Workspace, so a name changed in Settings survives.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved Installation Owner.
 * @returns Effect resolving the completed progress.
 */
function completeOnboardingEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
): Effect.Effect<OnboardingProgress, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    // The row lock orders completion against a concurrent save: the save either
    // commits its rename first (and completion keeps it) or sees the completion
    // and refuses. Two completions serialize rather than racing the update.
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

/**
 * Reads the request identifier from the Hono context.
 *
 * @param c - Hono request context.
 * @returns Unique request identifier.
 */
function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}

/**
 * Registers the first-run onboarding read, save, and complete routes.
 *
 * The surface is authenticated and Installation-Owner-only; it never mints a
 * privileged session, and the public setup status deliberately exposes none of
 * this state. Every read and mutation resolves the live actor, so the current
 * Owner resumes wherever the journey stopped, including after verification,
 * sign-in, or an ownership transfer.
 *
 * @param app - Hono application instance.
 */
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
        yield* fromPromise(() => onlyKeys(body, ["step", "workspace_name"]));
        const hasName = body.workspace_name !== undefined;
        const hasStep = body.step !== undefined;
        const name = hasName
          ? yield* fromPromise(() =>
              workspaceNameValue(stringField(body, "workspace_name"), "workspace_name"),
            )
          : null;
        const step = hasStep
          ? yield* fromPromise(() => {
              const value = body.step;
              if (value !== "improvement" && value !== "ready") {
                throw new CoreApiError(
                  400,
                  "validation_error",
                  "step must be `improvement` or `ready`.",
                );
              }
              return value;
            })
          : null;
        if (name === null && step === null) {
          return yield* Effect.fail(
            new CoreApiError(400, "validation_error", "Provide `workspace_name`, `step`, or both."),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ name, step }));
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.onboarding.save",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              // The name and the screen commit together: a restart resumes at the
              // screen whose save it acknowledges, never one ahead of it.
              if (name !== null) {
                yield* saveWorkspaceNameEffect(client, actor, requestId(c), name);
              } else {
                // The step-only path still refuses an upgraded installation.
                yield* lockOnboardingRow(client, actor);
              }
              const updated =
                step !== null
                  ? yield* saveOnboardingStepEffect(client, actor, step)
                  : yield* onboardingProgressEffect(client, actor);
              return { body: updated, replayed: false, status: 200 };
            }),
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
        const result = yield* idempotentMutation(
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
