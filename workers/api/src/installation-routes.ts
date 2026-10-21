import { Effect } from "effect";
import { INSTALLATION_SEAT_LIMIT, isWorkspaceRole, isoDateTime } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { betterAuthFor, checkAuthRateLimit } from "./better-auth";
import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import { jsonResponse } from "./responses";
import { requireSeatCapacityEffect, seatUsageEffect } from "./seats";
import {
  idempotencyKey,
  integerParam,
  jsonBody,
  onlyKeys,
  optionalStringField,
  stringField,
  textParam,
  uuidParam,
} from "./validation";
import { idempotentMutation } from "./workspace-lifecycle";

/** Lifecycle state returned after suspend/reactivate/hard-delete administration. */
interface AccountLifecycleBody {
  status: "active" | "suspended";
  suspended_at: string | null;
  suspension_reason: string | null;
  user_id: string;
}

interface InstallationMemberRow extends Record<string, unknown> {
  auth_user_id: string;
  display_name: string | null;
  email: string;
  id: string;
  installation_owner: boolean;
  role: string;
  suspended_at: Date | string | null;
  suspension_reason: string | null;
}

interface InstallationBody {
  installation_owner_user_id: string;
  invitations_pending: number;
  members_active: number;
  seat_limit: number;
  seats_used: number;
  workspace: {
    created_at: string;
    id: string;
    name: string;
    role: "admin" | "editor" | "viewer";
    slug: string;
    updated_at: string;
  };
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  actor_display_name: string | null;
  actor_email: string;
  after_state: unknown;
  before_state: unknown;
  created_at: Date | string;
  id: string;
  request_id: string;
  target_id: string;
  target_type: string;
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
 * Asserts the caller is the Installation Owner.
 *
 * @param actor - Resolved request actor.
 * @returns Effect that fails with 403 `installation_owner_required`.
 */
function requireInstallationOwner(actor: ResolvedActor): Effect.Effect<void, CoreApiError> {
  return actor.isInstallationOwner
    ? Effect.void
    : Effect.fail(
        new CoreApiError(
          403,
          "installation_owner_required",
          "The installation owner role is required.",
        ),
      );
}

/**
 * Asserts the caller may read installation settings and the Audit trail.
 *
 * @param actor - Resolved request actor.
 * @returns Effect that fails with 403 `workspace_admin_required`.
 */
function requireWorkspaceAdmin(actor: ResolvedActor): Effect.Effect<void, CoreApiError> {
  return actor.role === "admin" || actor.isInstallationOwner
    ? Effect.void
    : Effect.fail(
        new CoreApiError(403, "workspace_admin_required", "The workspace admin role is required."),
      );
}

/**
 * Loads one member of the shared Workspace with account lifecycle state inside
 * the caller's transaction.
 *
 * @param client - Active transaction client.
 * @param orgId - Shared Workspace UUID.
 * @param memberId - Internal user UUID.
 * @returns Effect resolving the member row.
 * @throws {CoreApiError} 404 `member_not_found` when the user is not a member.
 */
function loadMemberEffect(
  client: EffectTransactionClient,
  orgId: string,
  memberId: string,
): Effect.Effect<InstallationMemberRow, CoreApiError | DatabaseError> {
  return client
    .query<InstallationMemberRow>(
      `SELECT u.id, u.auth_user_id, u.email, u.display_name,
              u.installation_owner, u.suspended_at, u.suspension_reason,
              om.role
       FROM users u
       JOIN org_members om ON om.user_id = u.id AND om.org_id = $2
       WHERE u.id = $1`,
      [memberId, orgId],
    )
    .pipe(
      Effect.flatMap((result) => {
        const row = result.rows[0];
        return row
          ? Effect.succeed(row)
          : Effect.fail(
              new CoreApiError(
                404,
                "member_not_found",
                "The member was not found in this workspace.",
              ),
            );
      }),
    );
}

/**
 * Maps a member row to the account lifecycle response.
 *
 * @param row - Member row carrying suspension state.
 * @returns Lifecycle state for the member.
 */
function lifecycleBody(row: InstallationMemberRow): AccountLifecycleBody {
  return {
    status: row.suspended_at === null ? "active" : "suspended",
    suspended_at:
      row.suspended_at === null
        ? null
        : row.suspended_at instanceof Date
          ? row.suspended_at.toISOString()
          : new Date(row.suspended_at).toISOString(),
    suspension_reason: row.suspension_reason,
    user_id: row.id,
  };
}

/**
 * Extracts the fresh session token from a Better Auth sign-in response.
 *
 * @param value - Parsed JSON response body.
 * @returns The token string when present in either supported shape.
 */
function sessionTokenFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("token" in value && typeof value.token === "string") return value.token;
  if ("session" in value && value.session && typeof value.session === "object") {
    if ("token" in value.session && typeof value.session.token === "string") {
      return value.session.token;
    }
  }
  return undefined;
}

/**
 * Verifies the caller's current password without keeping the session it mints.
 *
 * Better Auth remains the credential authority. Reauthentication signs in with
 * the caller's own email/password; the fresh session token is deleted before it
 * can be used, so the check proves the password without issuing new authority.
 *
 * @param env - Worker environment bindings.
 * @param actor - Resolved caller whose email is reauthenticated.
 * @param password - Submitted current password.
 * @returns Effect resolving void for a valid password.
 * @throws {CoreApiError} 401 `reauthentication_failed` for invalid credentials;
 *   429 `rate_limited` when the sign-in attempt budget is exhausted.
 */
function reauthenticateEffect(
  env: ApiWorkerEnv,
  actor: ResolvedActor,
  password: string,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const auth = yield* Effect.promise(() => betterAuthFor(env));
    const base = env.BETTER_AUTH_URL?.trim() || env.PUBLIC_API_URL?.trim() || "http://localhost";
    const request = new Request(`${base}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: actor.email, password }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (env.DB_SYSTEM?.connectionString) {
      const limit = yield* Effect.promise(() => checkAuthRateLimit(env, "sign-in", request));
      if (limit.status === "limited") {
        return yield* Effect.fail(
          new CoreApiError(429, "rate_limited", "Too many authentication attempts. Retry later."),
        );
      }
    }
    const response = yield* Effect.promise(() => auth.handler(request));
    if (!response.ok) {
      return yield* Effect.fail(
        new CoreApiError(401, "reauthentication_failed", "Reauthentication failed."),
      );
    }
    const payload = yield* Effect.promise(() => response.clone().json());
    const token = sessionTokenFrom(payload);
    if (token) {
      yield* withSystemTransactionEffect(env, (client) =>
        client.query(`DELETE FROM "session" WHERE token = $1`, [token]),
      ).pipe(Effect.ignore);
    }
  });
}

/**
 * Registers installation administration routes.
 *
 * The surface is deliberately separate from Workspace content: the
 * Installation Owner controls account lifecycle and ownership, while Workspace
 * Admins read Seat usage and the Audit trail. Every mutation records an Audit
 * entry in the same transaction.
 *
 * @param app - Hono application instance.
 */
export function registerInstallationRoutes(app: Hono<ApiWorkerEnvironment>): void {
  app.get("/api/v1/installation", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireWorkspaceAdmin(actor);
        const body = yield* withSystemTransactionEffect(c.env, (client) =>
          Effect.gen(function* () {
            const usage = yield* seatUsageEffect(client, actor.workspace.id);
            const owner = yield* client.query<{ id: string }>(
              "SELECT id FROM users WHERE installation_owner LIMIT 1",
            );
            const workspace = yield* client.query<{
              created_at: Date | string;
              id: string;
              name: string;
              slug: string;
              updated_at: Date | string;
            }>("SELECT id, name, slug, created_at, updated_at FROM organizations WHERE id = $1", [
              actor.workspace.id,
            ]);
            const row = workspace.rows[0];
            if (!row) {
              return yield* Effect.fail(
                new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
              );
            }
            return {
              installation_owner_user_id: owner.rows[0]?.id ?? actor.userId,
              invitations_pending: usage.pendingInvitations,
              members_active: usage.activeMembers,
              seat_limit: INSTALLATION_SEAT_LIMIT,
              seats_used: usage.used,
              workspace: {
                created_at: isoDateTime(row.created_at),
                id: row.id,
                name: row.name,
                role: actor.role,
                slug: row.slug,
                updated_at: isoDateTime(row.updated_at),
              },
            } satisfies InstallationBody;
          }),
        );
        return jsonResponse(body, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/workspaces/:workspaceId/audit", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        yield* requireWorkspaceAdmin(actor);
        // The Workspace is bounded to the active one; an arbitrary path id
        // cannot read another tenant's audit trail.
        if (workspaceId !== actor.workspace.id) {
          return yield* Effect.fail(
            new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
          );
        }
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 50, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const action = yield* fromPromise(() => textParam(c.req.query("action"), "action", 100));
        const targetType = yield* fromPromise(() =>
          textParam(c.req.query("target_type"), "target_type", 64),
        );
        const search = yield* fromPromise(() => textParam(c.req.query("q"), "q", 100));
        // Filter predicates reuse one parameter each; a NULL means "no filter".
        // `q` uses strpos instead of LIKE so user text cannot act as wildcards.
        const entries = yield* withSystemTransactionEffect(c.env, (client) =>
          client
            .query<AuditRow>(
              `SELECT id, actor_email, actor_display_name, action, target_type,
                      target_id, before_state, after_state, request_id, created_at
               FROM workspace_audit_entries
               WHERE org_id = $1
                 AND ($4::text IS NULL OR action = $4)
                 AND ($5::text IS NULL OR target_type = $5)
                 AND ($6::text IS NULL
                      OR strpos(lower(action), lower($6)) > 0
                      OR strpos(lower(actor_email), lower($6)) > 0
                      OR strpos(lower(coalesce(actor_display_name, '')), lower($6)) > 0
                      OR strpos(lower(target_id), lower($6)) > 0)
               ORDER BY created_at DESC, id DESC
               LIMIT $2 OFFSET $3`,
              [workspaceId, limit + 1, offset, action ?? null, targetType ?? null, search ?? null],
            )
            .pipe(
              Effect.map((result) => ({
                hasMore: result.rows.length > limit,
                rows: result.rows.slice(0, limit),
              })),
            ),
        );
        return jsonResponse(
          {
            entries: entries.rows.map((row) => ({
              action: row.action,
              actor: {
                display_name: row.actor_display_name,
                email: row.actor_email,
              },
              after: row.after_state,
              before: row.before_state,
              created_at:
                row.created_at instanceof Date
                  ? row.created_at.toISOString()
                  : new Date(row.created_at).toISOString(),
              id: row.id,
              request_id: row.request_id,
              target_id: row.target_id,
              target_type: row.target_type,
            })),
            has_more: entries.hasMore,
            limit,
            offset,
          },
          200,
          requestId(c),
        );
      }),
    ),
  );

  app.post("/api/v1/installation/members/:memberId/suspend", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const memberId = yield* fromPromise(() => uuidParam(c.req.param("memberId"), "member_id"));
        const body = yield* fromPromise(() => jsonBody(c, true));
        yield* fromPromise(() => onlyKeys(body, ["reason"]));
        const reason = yield* fromPromise(() => {
          const value = optionalStringField(body, "reason");
          if (value !== undefined && value !== null && [...value].length > 500) {
            throw new CoreApiError(
              400,
              "validation_error",
              "reason must be at most 500 characters.",
            );
          }
          return value ?? null;
        });
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ memberId, reason }),
        );
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.member.suspend",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const member = yield* loadMemberEffect(client, actor.workspace.id, memberId);
              if (member.installation_owner || member.id === actor.userId) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "owner_self_removal",
                    "The installation owner cannot be suspended.",
                  ),
                );
              }
              if (member.suspended_at === null) {
                const updated = yield* client.query<InstallationMemberRow>(
                  `UPDATE users
                   SET suspended_at = now(), suspension_reason = $2, updated_at = now()
                   WHERE id = $1
                   RETURNING id, auth_user_id, email, display_name, installation_owner,
                             suspended_at, suspension_reason,
                             (SELECT role FROM org_members WHERE org_id = $3 AND user_id = $1) AS role`,
                  [memberId, reason, actor.workspace.id],
                );
                // Suspension revokes every existing session immediately.
                yield* client.query(`DELETE FROM "session" WHERE "userId" = $1`, [
                  member.auth_user_id,
                ]);
                yield* recordWorkspaceAuditEffect(client, {
                  action: "account.suspended",
                  actor: auditActorFrom({
                    display_name: actor.displayName,
                    email: actor.email,
                    id: actor.userId,
                  }),
                  after: { reason, status: "suspended" },
                  before: { status: "active" },
                  orgId: actor.workspace.id,
                  requestId: requestId(c),
                  targetId: memberId,
                  targetType: "member",
                });
                return {
                  body: lifecycleBody(updated.rows[0]!),
                  replayed: false,
                  status: 200,
                };
              }
              return { body: lifecycleBody(member), replayed: false, status: 200 };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/installation/members/:memberId/reactivate", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const memberId = yield* fromPromise(() => uuidParam(c.req.param("memberId"), "member_id"));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ memberId }));
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.member.reactivate",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const member = yield* loadMemberEffect(client, actor.workspace.id, memberId);
              if (member.suspended_at === null) {
                return { body: lifecycleBody(member), replayed: false, status: 200 };
              }
              yield* client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
                actor.workspace.id,
              ]);
              yield* requireSeatCapacityEffect(client, actor.workspace.id, 1);
              const updated = yield* client.query<InstallationMemberRow>(
                `UPDATE users
                 SET suspended_at = NULL, suspension_reason = NULL, updated_at = now()
                 WHERE id = $1
                 RETURNING id, auth_user_id, email, display_name, installation_owner,
                           suspended_at, suspension_reason,
                           (SELECT role FROM org_members WHERE org_id = $2 AND user_id = $1) AS role`,
                [memberId, actor.workspace.id],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "account.reactivated",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { status: "active" },
                before: { reason: member.suspension_reason, status: "suspended" },
                orgId: actor.workspace.id,
                requestId: requestId(c),
                targetId: memberId,
                targetType: "member",
              });
              return {
                body: lifecycleBody(updated.rows[0]!),
                replayed: false,
                status: 200,
              };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/installation/members/:memberId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const memberId = yield* fromPromise(() => uuidParam(c.req.param("memberId"), "member_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["confirm_email"]));
        const confirmEmail = yield* fromPromise(() =>
          stringField(body, "confirm_email").trim().toLowerCase(),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ confirmEmail, memberId }),
        );
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.member.delete",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const member = yield* loadMemberEffect(client, actor.workspace.id, memberId);
              if (member.installation_owner || member.id === actor.userId) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "owner_self_removal",
                    "The installation owner cannot be deleted.",
                  ),
                );
              }
              if (member.email.toLowerCase() !== confirmEmail) {
                return yield* Effect.fail(
                  new CoreApiError(
                    400,
                    "validation_error",
                    "confirm_email must match the member's email address.",
                  ),
                );
              }
              yield* client.query(`DELETE FROM "user" WHERE id = $1`, [member.auth_user_id]);
              yield* recordWorkspaceAuditEffect(client, {
                action: "account.deleted",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                before: {
                  email: member.email,
                  role: isWorkspaceRole(member.role) ? member.role : "viewer",
                },
                orgId: actor.workspace.id,
                requestId: requestId(c),
                targetId: memberId,
                targetType: "member",
              });
              return { body: null, replayed: false, status: 204 };
            }),
        );
        return new Response(null, {
          headers: {
            ...idempotencyHeaders(result.replayed),
            "X-Request-ID": requestId(c),
          },
          status: 204,
        });
      }),
    ),
  );

  app.post("/api/v1/installation/ownership-transfer", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        yield* requireInstallationOwner(actor);
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["password", "target_user_id"]));
        const targetUserId = yield* fromPromise(() =>
          uuidParam(stringField(body, "target_user_id"), "target_user_id"),
        );
        const password = yield* fromPromise(() => stringField(body, "password"));
        if (targetUserId === actor.userId) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "owner_transfer_invalid",
              "Choose another member to receive ownership.",
            ),
          );
        }
        yield* reauthenticateEffect(c.env, actor, password);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ targetUserId }));
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "installation.ownership.transfer",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const target = yield* loadMemberEffect(client, actor.workspace.id, targetUserId);
              if (
                target.installation_owner ||
                target.suspended_at !== null ||
                target.role !== "admin"
              ) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "owner_transfer_invalid",
                    "Ownership can only transfer to an active workspace admin.",
                  ),
                );
              }
              const owner = yield* client.query<{ id: string }>(
                `SELECT id FROM users WHERE installation_owner FOR UPDATE`,
              );
              const currentOwnerId = owner.rows[0]?.id;
              // Ownership may have moved while reauthentication was in flight.
              // Only the account that still owns the installation may transfer
              // it, so a stale request cannot overwrite a completed transfer.
              if (currentOwnerId !== actor.userId) {
                return yield* Effect.fail(
                  new CoreApiError(
                    403,
                    "installation_owner_required",
                    "The installation owner role is required.",
                  ),
                );
              }
              yield* client.query(
                `UPDATE users SET installation_owner = FALSE, updated_at = now()
                 WHERE id = $1`,
                [currentOwnerId],
              );
              yield* client.query(
                `UPDATE users SET installation_owner = TRUE, updated_at = now()
                 WHERE id = $1`,
                [targetUserId],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "installation.ownership_transferred",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { owner_user_id: targetUserId },
                before: { owner_user_id: currentOwnerId },
                orgId: actor.workspace.id,
                requestId: requestId(c),
                targetId: targetUserId,
                targetType: "member",
              });
              return {
                body: { installation_owner_user_id: targetUserId },
                replayed: false,
                status: 200,
              };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
}
