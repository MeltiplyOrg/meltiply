import { Effect, type Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { can, isWorkspaceRole, type DatabaseError, type WorkspaceRole } from "@meltiply/domain";
import { escapeMailHtml } from "@meltiply/domain/mail-content";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { CoreApiError } from "./core-types";
import { sha256Hex } from "./crypto";
import { withSystemTransactionEffect } from "./database";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { idempotencyHeaders } from "./idempotent-response";
import {
  createCloudflareMailSender,
  createMailServiceLive,
  MailService,
  mailSenderConfiguration,
  type MailMessage,
} from "./mail";
import { jsonResponse } from "./responses";
import { requireSeatCapacityEffect } from "./seats";
import {
  idempotencyKey,
  jsonBody,
  onlyKeys,
  optionalStringField,
  stringField,
  uuidParam,
} from "./validation";

/**
 * Workspace lifecycle REST surface implemented natively on the resolved actor.
 *
 * There is exactly one shared Workspace per installation; administration is
 * scoped to its path id and re-checked inside the transaction against
 * `org_members`. The installation Owner is not a content superadmin: content
 * authority comes from the Workspace role, while owner-only actions live in
 * the installation routes. Every administrative mutation records an Audit
 * entry in the same transaction.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INVITATION_TTL_DAYS = 7;

interface WorkspaceBody {
  created_at: string;
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
  updated_at: string;
}

type MemberStatus = "active" | "suspended";

interface WorkspaceMemberBody {
  avatar_url: string | null;
  created_at: string;
  display_name: string | null;
  email: string;
  is_installation_owner: boolean;
  role: WorkspaceRole;
  status: MemberStatus;
  suspended_at: string | null;
  updated_at: string;
  user_id: string;
}

type InvitationStatus = "accepted" | "expired" | "pending" | "revoked";

interface WorkspaceInvitationBody {
  created_at: string;
  email: string;
  expires_at: string;
  id: string;
  org_id: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  updated_at: string;
}

interface OrganizationRow extends Record<string, unknown> {
  created_at: Date | string;
  id: string;
  name: string;
  slug: string;
  updated_at: Date | string;
}

interface MemberRow extends Record<string, unknown> {
  avatar_url: string | null;
  created_at: Date | string;
  display_name: string | null;
  email: string;
  installation_owner: boolean;
  role: string;
  suspended_at: Date | string | null;
  updated_at: Date | string | null;
  user_id: string;
}

interface InvitationRow extends Record<string, unknown> {
  accepted_at: Date | string | null;
  created_at: Date | string;
  email: string;
  expires_at: Date | string;
  id: string;
  org_id: string;
  revoked_at: Date | string | null;
  role: string;
  updated_at: Date | string;
}

interface IdempotentResponse {
  body: unknown;
  replayed: boolean;
  status: number;
  /** Workspace display name carried out of the transaction for invitation email copy. */
  workspaceName?: string;
  /** Raw single-use token produced inside the transaction for email delivery. */
  token?: string;
}

/**
 * Optional `MailService` override mirroring the `storageServiceLayer` seam in
 * `CoreRouteDependencies`: tests inject `createMailServiceTest` doubles while
 * production resolves the live sender from the current invocation's `env` (see
 * `resolveMailServiceLayer`).
 */
export interface WorkspaceLifecycleDependencies {
  mailServiceLayer?:
    | Layer.Layer<MailService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<MailService, never, never>);
}

/**
 * Converts a database timestamp into the contract's ISO 8601 date-time string.
 *
 * @param value - TIMESTAMPTZ value returned by the driver (Date or ISO string).
 * @returns ISO 8601 string for the API envelope.
 */
function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Maps an organizations row plus the caller's membership role to the Workspace schema.
 *
 * @param row - organizations table row.
 * @param role - Caller's org_members role.
 * @returns OpenAPI Workspace response body.
 */
function workspaceBody(row: OrganizationRow, role: WorkspaceRole): WorkspaceBody {
  return {
    created_at: isoTimestamp(row.created_at),
    id: row.id,
    name: row.name,
    role,
    slug: row.slug,
    updated_at: isoTimestamp(row.updated_at),
  };
}

/**
 * Maps a joined org_members/users row to the WorkspaceMember schema.
 *
 * `status` reflects suspension, which is installation-level account state; a
 * suspended member keeps their membership and content attribution but releases
 * their Seat and cannot authenticate.
 *
 * @param row - Joined membership row.
 * @returns OpenAPI WorkspaceMember response body.
 */
function memberBody(row: MemberRow): WorkspaceMemberBody {
  const suspended = row.suspended_at !== null;
  return {
    avatar_url: row.avatar_url,
    created_at: isoTimestamp(row.created_at),
    display_name: row.display_name,
    email: row.email,
    is_installation_owner: row.installation_owner,
    role: isWorkspaceRole(row.role) ? row.role : "viewer",
    status: suspended ? "suspended" : "active",
    suspended_at: suspended ? isoTimestamp(row.suspended_at as Date | string) : null,
    updated_at: isoTimestamp(row.updated_at ?? row.created_at),
    user_id: row.user_id,
  };
}

/**
 * Derives the lifecycle status of an invitation row and maps it to the schema.
 *
 * Status order matters: an accepted or revoked timestamp wins over expiry so a
 * consumed invitation never flips to `expired` after the fact.
 *
 * @param row - workspace_invitations table row.
 * @returns OpenAPI WorkspaceInvitation response body.
 */
function invitationBody(row: InvitationRow): WorkspaceInvitationBody {
  const status: InvitationStatus =
    row.accepted_at !== null
      ? "accepted"
      : row.revoked_at !== null
        ? "revoked"
        : new Date(row.expires_at).getTime() <= Date.now()
          ? "expired"
          : "pending";
  return {
    created_at: isoTimestamp(row.created_at),
    email: row.email,
    expires_at: isoTimestamp(row.expires_at),
    id: row.id,
    org_id: row.org_id,
    role: isWorkspaceRole(row.role) ? row.role : "viewer",
    status,
    updated_at: isoTimestamp(row.updated_at),
  };
}

/**
 * Normalizes and validates an invitation email address.
 *
 * Lowercases and trims so the partial unique index on (org_id, email) enforces
 * one open invitation per address regardless of client casing.
 *
 * @param value - Raw email field from the request body.
 * @returns Normalized lowercase email.
 * @throws {CoreApiError} 400 `validation_error` when the value is not a plausible email.
 */
function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new CoreApiError(400, "validation_error", "email must be a valid email address.");
  }
  return email;
}

/**
 * Reads a required Workspace role from a request body.
 *
 * @param value - Untrusted role field.
 * @param field - Body field name used in the validation message.
 * @returns Validated Workspace role.
 * @throws {CoreApiError} 400 `validation_error` when the value is not a role.
 */
function workspaceRoleField(value: unknown, field: string): WorkspaceRole {
  if (!isWorkspaceRole(value)) {
    throw new CoreApiError(400, "validation_error", `${field} must be admin, editor, or viewer.`);
  }
  return value;
}

/**
 * Loads the caller's membership and the addressed Workspace inside one transaction.
 *
 * Membership is the authorization boundary for every lifecycle route: a
 * non-member gets 404 so Workspace existence is not leaked.
 *
 * @param client - Active Effect transaction client.
 * @param workspaceId - Workspace UUID from the path.
 * @param actor - Resolved request actor.
 * @returns Effect resolving to the Workspace row and the caller's role.
 * @throws {CoreApiError} 404 `workspace_not_found` when the Workspace is missing or inaccessible.
 */
function requireMembership(
  client: EffectTransactionClient,
  workspaceId: string,
  actor: ResolvedActor,
): Effect.Effect<
  { role: WorkspaceRole; workspace: OrganizationRow },
  CoreApiError | DatabaseError
> {
  return client
    .query<OrganizationRow & { member_role: string }>(
      `SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, om.role AS member_role
       FROM organizations o
       JOIN org_members om ON om.org_id = o.id AND om.user_id = $2
       WHERE o.id = $1 AND o.is_shared`,
      [workspaceId, actor.userId],
    )
    .pipe(
      Effect.flatMap((result) => {
        const row = result.rows[0];
        if (!row || !isWorkspaceRole(row.member_role)) {
          return Effect.fail(
            new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
          );
        }
        return Effect.succeed({ role: row.member_role, workspace: row });
      }),
    );
}

/**
 * Asserts the caller holds the Workspace Admin role in the addressed Workspace.
 *
 * @param role - Caller's membership role resolved by requireMembership.
 * @returns Effect that fails with 403 `workspace_admin_required` for non-admins.
 */
function requireAdmin(role: WorkspaceRole): Effect.Effect<void, CoreApiError> {
  return role === "admin"
    ? Effect.void
    : Effect.fail(
        new CoreApiError(403, "workspace_admin_required", "The workspace admin role is required."),
      );
}

/**
 * Asserts the resolved caller may assign a role to another person.
 *
 * Workspace Admins may invite and manage Editors and Viewers; only the
 * Installation Owner may assign Admin. The capability map is the authority so
 * the API and the frontend cannot disagree.
 *
 * @param actor - Resolved request actor.
 * @param role - Role being assigned.
 * @returns Effect that fails with 403 `forbidden_role_assignment`.
 */
function requireAssignableRole(
  actor: ResolvedActor,
  role: WorkspaceRole,
): Effect.Effect<void, CoreApiError> {
  const capability =
    role === "admin"
      ? "member:assign-admin"
      : role === "editor"
        ? "member:assign-editor"
        : "member:assign-viewer";
  return can(actor.role, actor.isInstallationOwner, capability)
    ? Effect.void
    : Effect.fail(
        new CoreApiError(403, "forbidden_role_assignment", "You cannot assign that role."),
      );
}

/**
 * Asserts a Workspace Admin is not modifying another Admin.
 *
 * Installation Ownership is installation-level authority and is the only path
 * that may change an Admin's role or membership.
 *
 * @param actor - Resolved request actor.
 * @param targetRole - Target member's current role.
 * @returns Effect that fails with 403 `forbidden_role_assignment`.
 */
function forbidAdminPeerMutation(
  actor: ResolvedActor,
  targetRole: WorkspaceRole,
): Effect.Effect<void, CoreApiError> {
  return targetRole === "admin" && !actor.isInstallationOwner
    ? Effect.fail(
        new CoreApiError(
          403,
          "forbidden_role_assignment",
          "Workspace admins cannot modify another admin.",
        ),
      )
    : Effect.void;
}

/**
 * Runs an idempotent lifecycle mutation inside one system transaction.
 *
 * Reserves the (org_id, operation, key) slot, replays the stored response on a
 * matching request hash, and records the produced status/body before commit so
 * a retried request returns the original outcome.
 *
 * @param env - Worker environment bindings.
 * @param organizationId - Workspace UUID scoping the idempotency key.
 * @param operation - Operation identifier (e.g. "workspace.update").
 * @param key - Validated Idempotency-Key header value.
 * @param requestHash - SHA-256 digest of the canonical request payload.
 * @param run - Transactional program producing the response status and body.
 * @returns Effect resolving to the fresh or replayed response.
 */
export function idempotentMutation(
  env: ApiWorkerEnv,
  organizationId: string,
  operation: string,
  key: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<IdempotentResponse, CoreApiError | DatabaseError>,
): Effect.Effect<IdempotentResponse, CoreApiError | DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const prior = yield* reserveIdempotencyEffect(
        client,
        organizationId,
        operation,
        key,
        requestHash,
      );
      if (prior) {
        return {
          body: prior.response_body,
          replayed: true,
          status: prior.response_status ?? 200,
        };
      }
      const produced = yield* run(client);
      yield* completeIdempotencyEffect(
        client,
        organizationId,
        operation,
        key,
        produced.status,
        produced.body,
      );
      return { ...produced, replayed: false };
    }),
  );
}

/**
 * Resolves the `MailService` Layer for invitation delivery.
 *
 * Injected dependencies (layers or env-derived layer factories, e.g. test
 * doubles) win; otherwise the layer is derived from the current invocation's
 * `env` so Worker bindings are never captured by a module-global Layer.
 *
 * @param env - Worker environment bindings of the current request.
 * @param dependencies - Route registration dependencies.
 * @returns Layer providing `MailService` for this request.
 */
function resolveMailServiceLayer(
  env: ApiWorkerEnv,
  dependencies: WorkspaceLifecycleDependencies,
): Layer.Layer<MailService, never, never> {
  const override = dependencies.mailServiceLayer;
  if (override !== undefined) {
    return typeof override === "function" ? override(env) : override;
  }
  return createMailServiceLive(createCloudflareMailSender(env.MAIL, mailSenderConfiguration(env)));
}

/**
 * Reduces a Workspace name to subject-line-safe text, collapsing control and
 * format characters so CRLF cannot split the mail header.
 *
 * @param name - Raw Workspace display name.
 * @returns Control-free name, or "your team" when nothing printable remains.
 */
function invitationSubjectWorkspaceName(name: string): string {
  const sanitized = name.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return sanitized.length > 0 ? sanitized : "your team";
}

/**
 * Renders the neutral `MailMessage` for a Workspace invitation.
 *
 * @param message - Recipient, acceptance link, and Workspace display name.
 * @returns Provider-neutral message ready for `MailService.send`.
 */
function renderInvitationMessage(message: {
  link: string;
  to: string;
  workspaceName: string;
}): MailMessage {
  const workspaceName = escapeMailHtml(message.workspaceName);
  const href = escapeMailHtml(message.link);
  return {
    html: `<p>You have been invited to join the <strong>${workspaceName}</strong> workspace on Meltiply.</p><p><a href="${href}">Accept the invitation</a> — this link expires in 7 days.</p>`,
    subject: `You're invited to ${invitationSubjectWorkspaceName(message.workspaceName)} on Meltiply`,
    text: `You have been invited to join the ${message.workspaceName} workspace on Meltiply.\n\nAccept the invitation: ${message.link}\nThis link expires in 7 days.`,
    to: message.to,
  };
}

/**
 * Builds the frontend acceptance URL for an invitation token.
 *
 * @param env - Worker environment bindings containing FRONTEND_URL.
 * @param token - Opaque invitation token (never stored server-side).
 * @returns Absolute acceptance link for the invitation email.
 * @throws {CoreApiError} 503 `service_unavailable` when FRONTEND_URL is unset.
 */
function invitationLink(env: ApiWorkerEnv, token: string): string {
  const base = env.FRONTEND_URL?.trim();
  if (!base) {
    throw new CoreApiError(503, "service_unavailable", "The frontend URL is unavailable.");
  }
  const url = new URL("/invitations/accept", base);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Submits one invitation email and owns the shared delivery-failure policy.
 *
 * Creation and resend both rotate or mint a single-use token before sending.
 * A `rejected` or `unavailable` submission is definitive, so the committed
 * idempotency record is removed: a client retry with the same key must execute
 * again rather than replay a response whose message was never delivered. A
 * created invitation is also revoked so its undelivered token cannot hold a
 * Seat; a resent invitation stays pending so the retry can rotate and resend.
 * An `ambiguous` outcome keeps both records because the provider may have
 * accepted the message. The caller's request fails with the typed mail error so
 * the API never reports an undelivered invitation as successful.
 *
 * @param env - Worker environment bindings used for the repair transaction.
 * @param invitation - Invitation whose id, Workspace, and recipient identify the message.
 * @param link - Absolute acceptance link carrying the raw token.
 * @param workspaceName - Workspace display name for the message copy.
 * @param operation - Idempotent operation whose record may be invalidated.
 * @param idempotencyKey - Client key committed by the invitation mutation.
 * @param revokeOnDefinitiveFailure - Whether a definitive failure releases the Seat.
 * @returns Effect resolving after the mail service accepts the submission.
 * @throws {CoreApiError} 503 `email_unavailable` or 502 `email_delivery_failed`.
 */
function submitInvitationEffect(
  env: ApiWorkerEnv,
  invitation: Pick<WorkspaceInvitationBody, "email" | "id" | "org_id">,
  link: string,
  workspaceName: string,
  operation: string,
  idempotencyKey: string,
  revokeOnDefinitiveFailure: boolean,
): Effect.Effect<void, CoreApiError, MailService> {
  return Effect.gen(function* () {
    const mail = yield* MailService;
    yield* mail.send(renderInvitationMessage({ link, to: invitation.email, workspaceName })).pipe(
      Effect.catchTag("MailSubmissionError", (failure) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("invitation_email_submission_failed").pipe(
            Effect.annotateLogs({
              invitation_id: invitation.id,
              mail_classification: failure.classification,
              mail_error: failure.message,
            }),
          );
          if (failure.classification !== "ambiguous") {
            yield* withSystemTransactionEffect(env, (client) =>
              Effect.gen(function* () {
                yield* client.query(
                  `DELETE FROM idempotency_keys
                   WHERE org_id = $1 AND operation = $2 AND idempotency_key = $3`,
                  [invitation.org_id, operation, idempotencyKey],
                );
                if (revokeOnDefinitiveFailure) {
                  yield* client.query(
                    `UPDATE workspace_invitations
                     SET revoked_at = now(), updated_at = now()
                     WHERE id = $1 AND accepted_at IS NULL`,
                    [invitation.id],
                  );
                }
              }),
            ).pipe(Effect.ignore);
          }
          return yield* Effect.fail(
            failure.classification === "unavailable"
              ? new CoreApiError(
                  503,
                  "email_unavailable",
                  "Invitation email delivery is not configured.",
                )
              : new CoreApiError(
                  502,
                  "email_delivery_failed",
                  failure.classification === "ambiguous"
                    ? "The invitation email delivery outcome could not be confirmed."
                    : "The invitation email could not be delivered.",
                ),
          );
        }),
      ),
    );
  });
}

/**
 * Registers the native Workspace lifecycle routes on the API router.
 *
 * @param app - Hono application instance.
 * @param dependencies - Optional `MailService` Layer override for tests.
 */
export function registerWorkspaceLifecycleRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: WorkspaceLifecycleDependencies = {},
): void {
  app.get("/api/v1/workspaces/:workspaceId/members", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const members = yield* withSystemTransactionEffect(c.env, (client) =>
          Effect.gen(function* () {
            const { role } = yield* requireMembership(client, workspaceId, actor);
            yield* requireAdmin(role);
            const result = yield* client.query<MemberRow>(
              `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                      u.email, u.display_name, u.avatar_url, u.suspended_at,
                      u.installation_owner
               FROM org_members om
               JOIN users u ON u.id = om.user_id
               WHERE om.org_id = $1
               ORDER BY om.created_at ASC, om.user_id ASC`,
              [workspaceId],
            );
            return result.rows.map(memberBody);
          }),
        );
        return jsonResponse({ members }, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/workspaces/:workspaceId/invitations", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        return yield* withSystemTransactionEffect(c.env, (client) =>
          Effect.gen(function* () {
            const { role } = yield* requireMembership(client, workspaceId, actor);
            yield* requireAdmin(role);
            const result = yield* client.query<InvitationRow>(
              `SELECT id, org_id, email, role, expires_at, accepted_at,
                      revoked_at, created_at, updated_at
               FROM workspace_invitations
               WHERE org_id = $1
                 AND accepted_at IS NULL
                 AND revoked_at IS NULL
                 AND expires_at > now()
               ORDER BY created_at DESC, id DESC`,
              [workspaceId],
            );
            return { invitations: result.rows.map(invitationBody) };
          }),
        ).pipe(Effect.map((body) => jsonResponse(body, 200, c.get("requestId"))));
      }),
    ),
  );

  app.patch("/api/v1/workspaces/:workspaceId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "slug"]));
        const name = body.name;
        const slug = body.slug;
        if (name === undefined && slug === undefined) {
          return yield* Effect.fail(
            new CoreApiError(400, "validation_error", "At least one of name or slug is required."),
          );
        }
        const nextName =
          name === undefined
            ? undefined
            : yield* fromPromise(() => {
                const value = stringField(body, "name");
                if (value.length > 200) {
                  throw new CoreApiError(
                    400,
                    "validation_error",
                    "name must be at most 200 characters.",
                  );
                }
                return value;
              });
        const nextSlug =
          slug === undefined
            ? undefined
            : yield* fromPromise(() => {
                const value = optionalStringField(body, "slug");
                if (typeof value !== "string" || !SLUG_PATTERN.test(value) || value.length > 100) {
                  throw new CoreApiError(
                    400,
                    "validation_error",
                    "slug must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ and be at most 100 characters.",
                  );
                }
                return value;
              });
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ name: nextName ?? null, slug: nextSlug ?? null }),
        );
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.update",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role, workspace } = yield* requireMembership(client, workspaceId, actor);
              yield* requireAdmin(role);
              const updated = yield* client.query<OrganizationRow>(
                `UPDATE organizations
                 SET name = COALESCE($2, name),
                     slug = COALESCE($3, slug),
                     updated_at = now()
                 WHERE id = $1
                 RETURNING id, name, slug, created_at, updated_at`,
                [workspaceId, nextName ?? null, nextSlug ?? null],
              );
              const row = updated.rows[0];
              if (!row) {
                return yield* Effect.fail(
                  new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
                );
              }
              yield* recordWorkspaceAuditEffect(client, {
                action: "workspace.renamed",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { name: row.name, slug: row.slug },
                before: { name: workspace.name, slug: workspace.slug },
                orgId: workspaceId,
                requestId: requestId(c),
                targetId: workspaceId,
                targetType: "workspace",
              });
              return {
                body: workspaceBody(row, role),
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

  app.post("/api/v1/workspaces/:workspaceId/invitations", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["email", "role"]));
        const email = yield* fromPromise(() => normalizedEmail(body.email));
        const role = yield* fromPromise(() => workspaceRoleField(body.role, "role"));
        yield* requireAssignableRole(actor, role);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ email, role }));
        const rawToken =
          crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const tokenHash = yield* Effect.promise(() => sha256Hex(rawToken));
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.invitation.create",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role: callerRole, workspace } = yield* requireMembership(
                client,
                workspaceId,
                actor,
              );
              yield* requireAdmin(callerRole);
              yield* requireAssignableRole(actor, role);
              yield* client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
                workspaceId,
              ]);
              const existingMember = yield* client.query<{ user_id: string }>(
                `SELECT om.user_id
                 FROM org_members om
                 JOIN users u ON u.id = om.user_id
                 WHERE om.org_id = $1 AND lower(u.email) = $2`,
                [workspaceId, email],
              );
              if (existingMember.rows[0]) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "workspace_member_exists",
                    "The address is already a workspace member.",
                  ),
                );
              }
              // Expired-but-unmarked rows still hold the (org_id, email) slot
              // in the pending unique index; clear them before inserting.
              yield* client.query(
                `UPDATE workspace_invitations
                 SET revoked_at = now(), updated_at = now()
                 WHERE org_id = $1 AND email = $2
                   AND accepted_at IS NULL AND revoked_at IS NULL
                   AND expires_at <= now()`,
                [workspaceId, email],
              );
              yield* requireSeatCapacityEffect(client, workspaceId, 1);
              const inserted = yield* client.query<InvitationRow>(
                `INSERT INTO workspace_invitations
                   (org_id, email, role, invited_by, token_hash, expires_at)
                 VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
                 ON CONFLICT (org_id, email)
                   WHERE accepted_at IS NULL AND revoked_at IS NULL
                 DO NOTHING
                 RETURNING id, org_id, email, role, expires_at, accepted_at,
                           revoked_at, created_at, updated_at`,
                [workspaceId, email, role, actor.userId, tokenHash, INVITATION_TTL_DAYS],
              );
              const invitation = inserted.rows[0];
              if (!invitation) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "invitation_pending",
                    "A pending invitation already exists for this address.",
                  ),
                );
              }
              yield* recordWorkspaceAuditEffect(client, {
                action: "invitation.created",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { email, role },
                orgId: workspaceId,
                requestId: requestId(c),
                targetId: invitation.id,
                targetType: "invitation",
              });
              return {
                body: invitationBody(invitation),
                replayed: false,
                status: 201,
                token: rawToken,
                workspaceName: workspace.name,
              };
            }),
        );
        if (!result.replayed) {
          const link = yield* fromPromise(() => invitationLink(c.env, result.token ?? ""));
          yield* submitInvitationEffect(
            c.env,
            result.body as WorkspaceInvitationBody,
            link,
            result.workspaceName ?? "your team",
            "workspace.invitation.create",
            key,
            true,
          );
        }
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }).pipe(Effect.provide(resolveMailServiceLayer(c.env, dependencies))),
    ),
  );

  app.post("/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const invitationId = yield* fromPromise(() =>
          uuidParam(c.req.param("invitationId"), "invitation_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ invitationId }));
        const rawToken =
          crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const tokenHash = yield* Effect.promise(() => sha256Hex(rawToken));
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.invitation.resend",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role, workspace } = yield* requireMembership(client, workspaceId, actor);
              yield* requireAdmin(role);
              const existing = yield* client.query<InvitationRow>(
                `SELECT id, org_id, email, role, expires_at, accepted_at,
                        revoked_at, created_at, updated_at
                 FROM workspace_invitations
                 WHERE id = $1 AND org_id = $2
                 FOR UPDATE`,
                [invitationId, workspaceId],
              );
              const invitation = existing.rows[0];
              if (!invitation) {
                return yield* Effect.fail(
                  new CoreApiError(404, "invitation_not_found", "The invitation was not found."),
                );
              }
              if (invitation.accepted_at !== null) {
                return yield* Effect.fail(
                  new CoreApiError(409, "invitation_used", "The invitation has already been used."),
                );
              }
              if (invitation.revoked_at !== null) {
                return yield* Effect.fail(
                  new CoreApiError(410, "invitation_revoked", "The invitation has been revoked."),
                );
              }
              // An expired invitation no longer reserves a Seat. Renewing it
              // consumes capacity again, so serialize with the Workspace lock
              // and re-check under the same rule used at creation.
              if (new Date(invitation.expires_at).getTime() <= Date.now()) {
                yield* client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
                  workspaceId,
                ]);
                yield* requireSeatCapacityEffect(client, workspaceId, 1);
              }
              const updated = yield* client.query<InvitationRow>(
                `UPDATE workspace_invitations
                 SET token_hash = $3,
                     expires_at = now() + make_interval(days => $4),
                     updated_at = now()
                 WHERE id = $1 AND org_id = $2
                 RETURNING id, org_id, email, role, expires_at, accepted_at,
                           revoked_at, created_at, updated_at`,
                [invitationId, workspaceId, tokenHash, INVITATION_TTL_DAYS],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "invitation.resent",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { email: invitation.email, role: invitation.role },
                orgId: workspaceId,
                requestId: requestId(c),
                targetId: invitationId,
                targetType: "invitation",
              });
              return {
                body: invitationBody(updated.rows[0]!),
                replayed: false,
                status: 200,
                token: rawToken,
                workspaceName: workspace.name,
              };
            }),
        );
        if (!result.replayed) {
          const link = yield* fromPromise(() => invitationLink(c.env, result.token ?? ""));
          yield* submitInvitationEffect(
            c.env,
            result.body as WorkspaceInvitationBody,
            link,
            result.workspaceName ?? "your team",
            "workspace.invitation.resend",
            key,
            false,
          );
        }
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }).pipe(Effect.provide(resolveMailServiceLayer(c.env, dependencies))),
    ),
  );

  app.delete("/api/v1/workspaces/:workspaceId/invitations/:invitationId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const invitationId = yield* fromPromise(() =>
          uuidParam(c.req.param("invitationId"), "invitation_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ invitationId }));
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.invitation.revoke",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role } = yield* requireMembership(client, workspaceId, actor);
              yield* requireAdmin(role);
              const existing = yield* client.query<InvitationRow>(
                `SELECT id, org_id, email, role, expires_at, accepted_at,
                        revoked_at, created_at, updated_at
                 FROM workspace_invitations
                 WHERE id = $1 AND org_id = $2
                 FOR UPDATE`,
                [invitationId, workspaceId],
              );
              const invitation = existing.rows[0];
              if (!invitation) {
                return yield* Effect.fail(
                  new CoreApiError(404, "invitation_not_found", "The invitation was not found."),
                );
              }
              if (invitation.accepted_at !== null) {
                return yield* Effect.fail(
                  new CoreApiError(409, "invitation_used", "The invitation has already been used."),
                );
              }
              yield* client.query(
                `UPDATE workspace_invitations
                 SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
                 WHERE id = $1 AND org_id = $2`,
                [invitationId, workspaceId],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "invitation.revoked",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { email: invitation.email, role: invitation.role },
                orgId: workspaceId,
                requestId: requestId(c),
                targetId: invitationId,
                targetType: "invitation",
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

  app.get("/api/v1/workspace-invitations/:token", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const token = c.req.param("token") ?? "";
        if (token.length < 16 || token.length > 255) {
          return yield* Effect.fail(
            new CoreApiError(400, "invalid_request", "A valid invitation token is required."),
          );
        }
        const tokenHash = yield* Effect.promise(() => sha256Hex(token));
        const preview = yield* withSystemTransactionEffect(c.env, (client) =>
          client.query<{
            accepted_at: Date | string | null;
            email: string;
            expires_at: Date | string;
            revoked_at: Date | string | null;
            role: string;
            workspace_name: string;
          }>(
            `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
                    o.name AS workspace_name
             FROM workspace_invitations i
             JOIN organizations o ON o.id = i.org_id
             WHERE i.token_hash = $1
             LIMIT 1`,
            [tokenHash],
          ),
        );
        const row = preview.rows[0];
        if (!row) {
          return yield* Effect.fail(
            new CoreApiError(404, "invitation_not_found", "The invitation was not found."),
          );
        }
        const status =
          row.accepted_at !== null
            ? "accepted"
            : row.revoked_at !== null
              ? "revoked"
              : new Date(row.expires_at).getTime() <= Date.now()
                ? "expired"
                : "pending";
        return jsonResponse(
          {
            email: row.email,
            expires_at: isoTimestamp(row.expires_at),
            role: isWorkspaceRole(row.role) ? row.role : "viewer",
            status,
            workspace_name: row.workspace_name,
          },
          200,
          requestId(c),
        );
      }),
    ),
  );

  app.post("/api/v1/workspace-invitations/:token/accept", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const token = c.req.param("token") ?? "";
        if (token.length < 16 || token.length > 255) {
          return yield* Effect.fail(
            new CoreApiError(400, "invalid_request", "A valid invitation token is required."),
          );
        }
        const tokenHash = yield* Effect.promise(() => sha256Hex(token));
        // The token is the idempotency credential: a consumed or replayed
        // acceptance resolves to the same membership row.
        const outcome = yield* withSystemTransactionEffect(c.env, (client) =>
          Effect.gen(function* () {
            const invitation = yield* client.query<InvitationRow>(
              `SELECT id, org_id, email, role, expires_at, accepted_at,
                      revoked_at, created_at, updated_at
               FROM workspace_invitations
               WHERE token_hash = $1
               FOR UPDATE`,
              [tokenHash],
            );
            const row = invitation.rows[0];
            if (!row) {
              return yield* Effect.fail(
                new CoreApiError(404, "invitation_not_found", "The invitation was not found."),
              );
            }
            if (row.accepted_at !== null) {
              // Actor resolution activates a verified invitation automatically.
              // Replaying the link for the same account returns that membership;
              // any other caller still sees the used-invitation error.
              const existing = yield* client.query<{
                avatar_url: string | null;
                created_at: Date | string;
                display_name: string | null;
                email: string;
                installation_owner: boolean;
                role: string;
                suspended_at: Date | string | null;
                updated_at: Date | string;
                user_id: string;
              }>(
                `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                        u.email, u.display_name, u.avatar_url, u.suspended_at,
                        u.installation_owner
                 FROM org_members om
                 JOIN users u ON u.id = om.user_id
                 WHERE om.org_id = $1 AND om.user_id = $2`,
                [row.org_id, actor.userId],
              );
              const member = existing.rows[0];
              if (member && member.email.toLowerCase() === row.email.toLowerCase()) {
                const organization = yield* client.query<OrganizationRow>(
                  `SELECT id, name, slug, created_at, updated_at
                   FROM organizations WHERE id = $1`,
                  [row.org_id],
                );
                const workspace = organization.rows[0];
                if (workspace) {
                  return {
                    member: memberBody(member),
                    workspace: workspaceBody(
                      workspace,
                      isWorkspaceRole(member.role) ? member.role : "viewer",
                    ),
                  };
                }
              }
              return yield* Effect.fail(
                new CoreApiError(409, "invitation_used", "The invitation has already been used."),
              );
            }
            if (row.revoked_at !== null) {
              return yield* Effect.fail(
                new CoreApiError(410, "invitation_revoked", "The invitation has been revoked."),
              );
            }
            if (new Date(row.expires_at).getTime() <= Date.now()) {
              return yield* Effect.fail(
                new CoreApiError(410, "invitation_expired", "The invitation has expired."),
              );
            }
            const user = yield* client.query<{
              display_name: string | null;
              email: string;
              id: string;
              suspended_at: Date | string | null;
            }>(
              `SELECT u.id, u.email, u.display_name, u.suspended_at
               FROM users u
               WHERE u.id = $1`,
              [actor.userId],
            );
            const account = user.rows[0];
            const actorEmail = account?.email.toLowerCase();
            if (!account || !actorEmail || actorEmail !== row.email.toLowerCase()) {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "invitation_email_mismatch",
                  "The invitation was issued to a different email address.",
                ),
              );
            }
            if (account.suspended_at !== null) {
              return yield* Effect.fail(
                new CoreApiError(403, "account_suspended", "This account is suspended."),
              );
            }
            const verified = yield* client.query<{ email_verified: boolean }>(
              `SELECT u."emailVerified" AS email_verified
               FROM "user" u WHERE u.id = $1`,
              [actor.authUserId],
            );
            const localOrTest = c.env.ENVIRONMENT === "local" || c.env.ENVIRONMENT === "test";
            if (!verified.rows[0]?.email_verified && !localOrTest) {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "email_verification_required",
                  "Verify your email before joining the workspace.",
                ),
              );
            }
            yield* client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
              row.org_id,
            ]);
            yield* requireSeatCapacityEffect(client, row.org_id);
            const membership = yield* client.query<MemberRow>(
              `INSERT INTO org_members (org_id, user_id, role)
               VALUES ($1, $2, $3)
               ON CONFLICT (org_id, user_id) DO UPDATE
                 SET role = org_members.role
               RETURNING user_id, role, created_at, updated_at,
                         $4::text AS email, $5::text AS display_name,
                         NULL::text AS avatar_url, $6::timestamptz AS suspended_at,
                         FALSE AS installation_owner`,
              [row.org_id, actor.userId, row.role, account.email, account.display_name, null],
            );
            const member = membership.rows[0];
            if (!member) {
              return yield* Effect.fail(
                new CoreApiError(500, "internal_error", "The membership could not be recorded."),
              );
            }
            yield* client.query(
              `UPDATE workspace_invitations
               SET accepted_at = now(), updated_at = now()
               WHERE id = $1 AND accepted_at IS NULL`,
              [row.id],
            );
            yield* recordWorkspaceAuditEffect(client, {
              action: "invitation.accepted",
              actor: auditActorFrom(account),
              after: { email: account.email, role: member.role },
              orgId: row.org_id,
              requestId: requestId(c),
              targetId: row.id,
              targetType: "invitation",
            });
            const organization = yield* client.query<OrganizationRow>(
              `SELECT id, name, slug, created_at, updated_at
               FROM organizations WHERE id = $1`,
              [row.org_id],
            );
            const workspace = organization.rows[0];
            if (!workspace) {
              return yield* Effect.fail(
                new CoreApiError(
                  500,
                  "internal_error",
                  "The workspace membership could not be loaded.",
                ),
              );
            }
            return {
              member: memberBody(member),
              workspace: workspaceBody(
                workspace,
                isWorkspaceRole(member.role) ? member.role : "viewer",
              ),
            };
          }),
        );
        return jsonResponse(outcome, 200, requestId(c));
      }),
    ),
  );

  app.patch("/api/v1/workspaces/:workspaceId/members/:memberId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const memberId = yield* fromPromise(() => uuidParam(c.req.param("memberId"), "member_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["role"]));
        const role = yield* fromPromise(() => workspaceRoleField(body.role, "role"));
        yield* requireAssignableRole(actor, role);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ memberId, role }));
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.member.update",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role: callerRole } = yield* requireMembership(client, workspaceId, actor);
              yield* requireAdmin(callerRole);
              yield* requireAssignableRole(actor, role);
              const target = yield* client.query<MemberRow>(
                `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                        u.email, u.display_name, u.avatar_url, u.suspended_at,
                        u.installation_owner
                 FROM org_members om
                 JOIN users u ON u.id = om.user_id
                 WHERE om.org_id = $1 AND om.user_id = $2
                 FOR UPDATE OF om`,
                [workspaceId, memberId],
              );
              const member = target.rows[0];
              if (!member) {
                return yield* Effect.fail(
                  new CoreApiError(
                    404,
                    "member_not_found",
                    "The member was not found in this workspace.",
                  ),
                );
              }
              const currentRole = isWorkspaceRole(member.role) ? member.role : "viewer";
              yield* forbidAdminPeerMutation(actor, currentRole);
              if (member.installation_owner && !actor.isInstallationOwner) {
                return yield* Effect.fail(
                  new CoreApiError(
                    403,
                    "forbidden_role_assignment",
                    "The installation owner's role cannot be changed.",
                  ),
                );
              }
              if (member.installation_owner && role !== "admin") {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "owner_role_required",
                    "Transfer installation ownership before changing the owner's workspace role.",
                  ),
                );
              }
              if (currentRole === "admin" && role !== "admin") {
                const admins = yield* client.query<{ count: string }>(
                  `SELECT count(*)::text AS count
                   FROM org_members
                   WHERE org_id = $1 AND role = 'admin'`,
                  [workspaceId],
                );
                if (Number(admins.rows[0]?.count ?? "0") <= 1) {
                  return yield* Effect.fail(
                    new CoreApiError(
                      409,
                      "last_admin",
                      "The last workspace admin cannot be demoted.",
                    ),
                  );
                }
              }
              const updated = yield* client.query<MemberRow>(
                `UPDATE org_members om
                 SET role = $3, updated_at = now()
                 FROM users u
                 WHERE om.org_id = $1 AND om.user_id = $2 AND u.id = om.user_id
                 RETURNING om.user_id, om.role, om.created_at, om.updated_at,
                           u.email, u.display_name, u.avatar_url, u.suspended_at,
                           u.installation_owner`,
                [workspaceId, memberId, role],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "member.role_changed",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                after: { role },
                before: { role: currentRole },
                orgId: workspaceId,
                requestId: requestId(c),
                targetId: memberId,
                targetType: "member",
              });
              return {
                body: memberBody(updated.rows[0]!),
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

  app.delete("/api/v1/workspaces/:workspaceId/members/:memberId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const workspaceId = yield* fromPromise(() =>
          uuidParam(c.req.param("workspaceId"), "workspace_id"),
        );
        const memberId = yield* fromPromise(() => uuidParam(c.req.param("memberId"), "member_id"));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ memberId }));
        const result = yield* idempotentMutation(
          c.env,
          workspaceId,
          "workspace.member.remove",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const { role: callerRole } = yield* requireMembership(client, workspaceId, actor);
              const target = yield* client.query<MemberRow>(
                `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                        u.email, u.display_name, u.avatar_url, u.suspended_at,
                        u.installation_owner
                 FROM org_members om
                 JOIN users u ON u.id = om.user_id
                 WHERE om.org_id = $1 AND om.user_id = $2
                 FOR UPDATE OF om`,
                [workspaceId, memberId],
              );
              const member = target.rows[0];
              if (!member) {
                return yield* Effect.fail(
                  new CoreApiError(
                    404,
                    "member_not_found",
                    "The member was not found in this workspace.",
                  ),
                );
              }
              const selfRemoval = memberId === actor.userId;
              if (!selfRemoval) {
                yield* requireAdmin(callerRole);
                yield* forbidAdminPeerMutation(
                  actor,
                  isWorkspaceRole(member.role) ? member.role : "viewer",
                );
              }
              if (member.installation_owner) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "owner_self_removal",
                    "Transfer installation ownership before removing the owner.",
                  ),
                );
              }
              if (member.role === "admin") {
                const admins = yield* client.query<{ count: string }>(
                  `SELECT count(*)::text AS count
                   FROM org_members
                   WHERE org_id = $1 AND role = 'admin'`,
                  [workspaceId],
                );
                if (Number(admins.rows[0]?.count ?? "0") <= 1) {
                  return yield* Effect.fail(
                    new CoreApiError(
                      409,
                      "last_admin",
                      "The last workspace admin cannot be removed.",
                    ),
                  );
                }
              }
              yield* client.query(
                `DELETE FROM org_members
                 WHERE org_id = $1 AND user_id = $2`,
                [workspaceId, memberId],
              );
              yield* recordWorkspaceAuditEffect(client, {
                action: "member.removed",
                actor: auditActorFrom({
                  display_name: actor.displayName,
                  email: actor.email,
                  id: actor.userId,
                }),
                before: { role: member.role },
                orgId: workspaceId,
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
}

/**
 * Retrieves the unique request identifier stored on the Hono execution context.
 *
 * @param c - Hono request context.
 * @returns Request ID string (from `X-Request-ID` or generated).
 */
function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}
