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
export interface OnboardingProgress {
  completed_at: string | null;
  status: "completed" | "in_progress" | "not_applicable";
  workspace_name: string | null;
  workspace_named: boolean;
}

interface OnboardingRow extends Record<string, unknown> {
  completed_at: Date | string | null;
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
      `SELECT o.name AS workspace_name, ob.workspace_named, ob.completed_at
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
            status: "not_applicable",
            workspace_name: null,
            workspace_named: false,
          } satisfies OnboardingProgress;
        }
        if (row.completed_at !== null) {
          return {
            completed_at: isoDateTime(row.completed_at),
            status: "completed",
            workspace_name: row.workspace_name,
            workspace_named: row.workspace_named === true,
          } satisfies OnboardingProgress;
        }
        return {
          completed_at: null,
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
 * Loads the caller's onboarding row, refusing installations that never began it.
 *
 * @param client - Active system transaction client.
 * @param actor - Resolved Installation Owner.
 * @returns Effect resolving the row.
 * @throws {CoreApiError} 409 `onboarding_not_applicable` for an upgraded installation.
 */
function openOnboardingRowEffect(
  client: EffectTransactionClient,
  actor: ResolvedActor,
): Effect.Effect<
  { completed_at: Date | string | null; workspace_named: boolean },
  CoreApiError | DatabaseError
> {
  return client
    .query<{ completed_at: Date | string | null; workspace_named: boolean }>(
      `SELECT completed_at, workspace_named FROM installation_onboarding WHERE org_id = $1`,
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
 * Applies the chosen Workspace name to the canonical shared Workspace.
 *
 * Runs inside the caller's transaction: the Workspace row is locked so two
 * concurrent saves serialize, the name is written only when it differs, and the
 * rename is audited with the action Settings uses. Completion is terminal, so
 * this refuses to rewrite a name the Owner later changed through Settings.
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
    const onboarding = yield* openOnboardingRowEffect(client, actor);
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
    yield* openOnboardingRowEffect(client, actor);
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
        yield* fromPromise(() => onlyKeys(body, ["workspace_name"]));
        const name = yield* fromPromise(() =>
          workspaceNameValue(stringField(body, "workspace_name"), "workspace_name"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ name }));
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.onboarding.save",
          key,
          requestHash,
          (client) =>
            Effect.map(saveWorkspaceNameEffect(client, actor, requestId(c), name), (body) => ({
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
