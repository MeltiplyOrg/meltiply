import { Effect, type Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { escapeMailHtml } from "@meltiply/domain/mail-content";
import type { Context, Hono } from "hono";

import type { ResolvedActor } from "./actor-resolution";
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
 * Every management operation is server-authoritative: the addressed workspace
 * comes from the path parameter, membership and role are re-checked inside the
 * transaction against `org_members`, and the untrusted `X-Workspace-ID` header
 * is never consulted on these routes. All work runs through
 * `withSystemTransactionEffect` because lifecycle operations span workspaces
 * (creating a new one, accepting an invitation into another one) and must not
 * be constrained by the caller's currently selected tenant RLS claims.
 */

type WorkspaceRole = "admin" | "member";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface WorkspaceBody {
  created_at: string;
  id: string;
  is_personal: boolean;
  name: string;
  role: WorkspaceRole;
  slug: string;
  updated_at: string;
}

interface WorkspaceMemberBody {
  avatar_url: string | null;
  created_at: string;
  display_name: string | null;
  email: string;
  role: WorkspaceRole;
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
  personal_user_id: string | null;
  slug: string;
  updated_at: Date | string;
}

interface MemberRow extends Record<string, unknown> {
  avatar_url: string | null;
  created_at: Date | string;
  display_name: string | null;
  email: string;
  role: string;
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
}

/**
 * Optional `MailService` override mirroring the `storageServiceLayer` seam in
 * `CoreRouteDependencies`: tests inject `createMailServiceTest` doubles while
 * production resolves the live sender from the current invocation's `env` (see
 * `resolveMailServiceLayer`). There is no delivery-skipping mode — a missing
 * binding or sender surfaces as the `unavailable` mail failure.
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
 * @param role - Caller's org_members role in this workspace.
 * @returns OpenAPI Workspace response body.
 */
function workspaceBody(row: OrganizationRow, role: WorkspaceRole): WorkspaceBody {
  return {
    created_at: isoTimestamp(row.created_at),
    id: row.id,
    is_personal: row.personal_user_id !== null,
    name: row.name,
    role,
    slug: row.slug,
    updated_at: isoTimestamp(row.updated_at),
  };
}

/**
 * Maps a joined org_members/users row to the WorkspaceMember schema.
 *
 * @param row - Joined membership row.
 * @returns OpenAPI WorkspaceMember response body.
 */
function memberBody(row: MemberRow): WorkspaceMemberBody {
  return {
    avatar_url: row.avatar_url,
    created_at: isoTimestamp(row.created_at),
    display_name: row.display_name,
    email: row.email,
    role: row.role as WorkspaceRole,
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
    role: row.role as WorkspaceRole,
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
 * Validates an optional slug override or derives one from the workspace name.
 *
 * Derived slugs append a random 8-character suffix so two workspaces named the
 * same do not collide on the unique slug index; explicit slugs must already
 * match the contract pattern.
 *
 * @param name - Workspace display name used for derivation.
 * @param supplied - Optional client-supplied slug.
 * @returns Contract-valid slug string.
 * @throws {CoreApiError} 400 `validation_error` when a supplied slug violates the pattern.
 */
function workspaceSlug(name: string, supplied: string | undefined): string {
  if (supplied !== undefined) {
    const slug = supplied.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug) || slug.length > 100) {
      throw new CoreApiError(
        400,
        "validation_error",
        "slug must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ and be at most 100 characters.",
      );
    }
    return slug;
  }
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "workspace";
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`;
}

/**
 * Loads the caller's membership and the addressed workspace inside one transaction.
 *
 * Membership in the addressed workspace is the authorization boundary for every
 * lifecycle route: a non-member gets 404 so workspace existence is not leaked.
 *
 * @param client - Active Effect transaction client.
 * @param workspaceId - Workspace UUID from the path.
 * @param actor - Resolved request actor.
 * @returns Effect resolving to the workspace row and the caller's role.
 * Fails with {CoreApiError} 404 `workspace_not_found` when the workspace is
 * missing or the actor is not a member.
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
      `SELECT o.id, o.name, o.slug, o.personal_user_id,
              o.created_at, o.updated_at, om.role AS member_role
       FROM organizations o
       JOIN org_members om ON om.org_id = o.id AND om.user_id = $2
       WHERE o.id = $1`,
      [workspaceId, actor.userId],
    )
    .pipe(
      Effect.flatMap((result) => {
        const row = result.rows[0];
        if (!row) {
          return Effect.fail(
            new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
          );
        }
        return Effect.succeed({
          role: row.member_role as WorkspaceRole,
          workspace: row,
        });
      }),
    );
}

/**
 * Asserts the caller holds the admin role in the addressed workspace.
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
 * Guards against mutating a personal workspace through team lifecycle routes.
 *
 * @param workspace - Addressed organizations row.
 * @returns Effect that fails with 409 `personal_workspace` for personal workspaces.
 */
function requireTeamWorkspace(workspace: OrganizationRow): Effect.Effect<void, CoreApiError> {
  return workspace.personal_user_id === null
    ? Effect.void
    : Effect.fail(
        new CoreApiError(
          409,
          "personal_workspace",
          "Personal workspaces do not support this operation.",
        ),
      );
}

/**
 * Runs an idempotent workspace mutation inside one system transaction.
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
function idempotentMutation(
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
 * Resolves the `MailService` Layer for the invitation create route.
 *
 * Injected dependencies (layers or env-derived layer factories, e.g. test
 * doubles) win; otherwise the layer is derived from the current invocation's
 * `env` so Worker bindings are never captured by a module-global Layer. The
 * resulting program runs under `runRouteEffect` with the standard
 * `RequestContext` scope — no separate mail runtime is introduced.
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
 * Reduces a workspace name to subject-line-safe text. The invitation
 * subject interpolates the workspace name into a single header value, so
 * control/format characters (including CRLF, which would split headers)
 * are collapsed rather than delivered to the mail binding.
 *
 * @param name - Raw workspace display name.
 * @returns Control-free name, or "your team" when nothing printable remains.
 */
function invitationSubjectWorkspaceName(name: string): string {
  const sanitized = name.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return sanitized.length > 0 ? sanitized : "your team";
}

/**
 * Renders the neutral `MailMessage` for a workspace invitation.
 *
 * The acceptance link points at the frontend's invitation route carrying the
 * opaque token; only the token hash is persisted server-side. HTML and plain
 * text bodies carry the same content so the message reads in every client;
 * variable content is HTML-escaped (`escapeMailHtml`) while the plain-text
 * body and subject stay unescaped (HTML entities would display literally).
 *
 * @param message - Recipient, acceptance link, and workspace display name.
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
 * Registers the native workspace lifecycle routes on the API router.
 *
 * Implements the Workspaces tag of the OpenAPI contract: team workspace
 * creation, rename/re-slug, member role changes and removal, and the
 * invitation create/revoke/accept flow. All routes require the resolved actor
 * (the auth middleware rejects unauthenticated requests before dispatch) and
 * re-verify membership against the path-addressed workspace inside the
 * transaction.
 *
 * @param app - Hono application instance.
 * @param dependencies - Optional `MailService` Layer override for tests.
 */
export function registerWorkspaceLifecycleRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: WorkspaceLifecycleDependencies = {},
): void {
  app.post("/api/v1/workspaces", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "slug"]));
        const name = yield* fromPromise(() => stringField(body, "name"));
        if (name.length > 200) {
          return yield* Effect.fail(
            new CoreApiError(400, "validation_error", "name must be at most 200 characters."),
          );
        }
        const slug = yield* fromPromise(() =>
          workspaceSlug(name, optionalStringField(body, "slug") ?? undefined),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ name, slug }));
        // The new workspace has no id yet, so the caller's current workspace
        // scopes the idempotency key; retries from the same session replay.
        const result = yield* idempotentMutation(
          c.env,
          actor.workspace.id,
          "workspace.create",
          key,
          requestHash,
          (client) =>
            Effect.gen(function* () {
              const inserted = yield* client.query<OrganizationRow>(
                `INSERT INTO organizations (name, slug)
                 VALUES ($1, $2)
                 ON CONFLICT (slug) DO NOTHING
                 RETURNING id, name, slug, personal_user_id, created_at, updated_at`,
                [name, slug],
              );
              const organization = inserted.rows[0];
              if (!organization) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "workspace_slug_taken",
                    "The workspace slug is already in use.",
                  ),
                );
              }
              yield* client.query(
                `INSERT INTO org_members (org_id, user_id, role)
                 VALUES ($1, $2, 'admin')`,
                [organization.id, actor.userId],
              );
              yield* client.query(
                `INSERT INTO usage_reconciliation_state (org_id)
                 VALUES ($1)
                 ON CONFLICT (org_id) DO NOTHING`,
                [organization.id],
              );
              return {
                body: workspaceBody(organization, "admin"),
                replayed: false,
                status: 201,
              };
            }),
        );
        return jsonResponse(result.body, result.status, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
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
              yield* requireTeamWorkspace(workspace);
              const updated = yield* client.query<OrganizationRow>(
                `UPDATE organizations
                 SET name = COALESCE($2, name),
                     slug = COALESCE($3, slug),
                     updated_at = now()
                 WHERE id = $1
                 RETURNING id, name, slug, personal_user_id, created_at, updated_at`,
                [workspaceId, nextName ?? null, nextSlug ?? null],
              );
              const row = updated.rows[0];
              if (!row) {
                return yield* Effect.fail(
                  new CoreApiError(404, "workspace_not_found", "The workspace was not found."),
                );
              }
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
        const role = yield* fromPromise(() => {
          const value = body.role;
          if (value === undefined) return "member";
          if (value !== "admin" && value !== "member") {
            throw new CoreApiError(400, "validation_error", "role must be admin or member.");
          }
          return value;
        });
        const key = yield* fromPromise(() => idempotencyKey(c));
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ email, role }));
        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const tokenHash = yield* Effect.promise(() => sha256Hex(token));
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
              yield* requireTeamWorkspace(workspace);
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
              // in the pending unique index; clear them before inserting so a
              // re-invite of the same address succeeds.
              yield* client.query(
                `UPDATE workspace_invitations
                 SET revoked_at = now(), updated_at = now()
                 WHERE org_id = $1 AND email = $2
                   AND accepted_at IS NULL AND revoked_at IS NULL
                   AND expires_at <= now()`,
                [workspaceId, email],
              );
              const inserted = yield* client.query<InvitationRow>(
                `INSERT INTO workspace_invitations
                   (org_id, email, role, invited_by, token_hash, expires_at)
                 VALUES ($1, $2, $3, $4, $5, now() + INTERVAL '7 days')
                 ON CONFLICT (org_id, email)
                   WHERE accepted_at IS NULL AND revoked_at IS NULL
                 DO NOTHING
                 RETURNING id, org_id, email, role, expires_at, accepted_at,
                           revoked_at, created_at, updated_at`,
                [workspaceId, email, role, actor.userId, tokenHash],
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
              return {
                body: invitationBody(invitation),
                replayed: false,
                status: 201,
                workspaceName: workspace.name,
              };
            }),
        );
        if (!result.replayed) {
          // Delivery happens after commit so a provider failure cannot roll
          // back the recorded invitation. Definitive failures (unavailable
          // configuration, rejection, rate limits, quota, infrastructure) keep
          // the existing revocation behavior so an undeliverable invitation
          // does not linger. An ambiguous submission is never revoked and
          // never resubmitted: the provider may already have accepted the
          // message, so revoking would revoke on unproven evidence and a
          // resend could duplicate an accepted send. The invitation stays
          // pending — an admin can revoke it and re-invite deliberately — and
          // the outcome stays identifiable through the sanitized warn log and
          // the neutral `MailSubmissionError` classification. A Worker crash
          // between vendor acceptance and response mapping is an unavoidable
          // external-write window that this design accepts rather than adding
          // an Outbox.
          const link = yield* fromPromise(() => invitationLink(c.env, token));
          const invitation = result.body as WorkspaceInvitationBody;
          const mail = yield* MailService;
          yield* mail
            .send(
              renderInvitationMessage({
                link,
                to: email,
                workspaceName: result.workspaceName ?? "your team",
              }),
            )
            .pipe(
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
                    yield* withSystemTransactionEffect(c.env, (client) =>
                      client.query(
                        `UPDATE workspace_invitations
                         SET revoked_at = now(), updated_at = now()
                         WHERE id = $1 AND accepted_at IS NULL`,
                        [invitation.id],
                      ),
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
              const revoked = yield* client.query(
                `UPDATE workspace_invitations
                   SET revoked_at = now(), updated_at = now()
                   WHERE id = $1 AND org_id = $2
                     AND accepted_at IS NULL AND revoked_at IS NULL`,
                [invitationId, workspaceId],
              );
              if (revoked.rowCount !== 1) {
                const existing = yield* client.query<{ id: string }>(
                  `SELECT id FROM workspace_invitations
                     WHERE id = $1 AND org_id = $2`,
                  [invitationId, workspaceId],
                );
                if (!existing.rows[0]) {
                  return yield* Effect.fail(
                    new CoreApiError(404, "invitation_not_found", "The invitation was not found."),
                  );
                }
              }
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
            const user = yield* client.query<{ email: string }>(
              "SELECT email FROM users WHERE id = $1",
              [actor.userId],
            );
            const actorEmail = user.rows[0]?.email.toLowerCase();
            if (!actorEmail || actorEmail !== row.email) {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "invitation_email_mismatch",
                  "The invitation was issued to a different email address.",
                ),
              );
            }
            const membership = yield* client.query<MemberRow>(
              `INSERT INTO org_members (org_id, user_id, role)
               VALUES ($1, $2, $3)
               ON CONFLICT (org_id, user_id) DO UPDATE
                 SET role = org_members.role
               RETURNING user_id, role, created_at, updated_at`,
              [row.org_id, actor.userId, row.role],
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
            const joined = yield* client.query<MemberRow>(
              `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                      u.email, u.display_name, u.avatar_url
               FROM org_members om
               JOIN users u ON u.id = om.user_id
               WHERE om.org_id = $1 AND om.user_id = $2`,
              [row.org_id, actor.userId],
            );
            const organization = yield* client.query<OrganizationRow>(
              `SELECT id, name, slug, personal_user_id, created_at, updated_at
               FROM organizations WHERE id = $1`,
              [row.org_id],
            );
            const workspace = organization.rows[0];
            if (!workspace || !joined.rows[0]) {
              return yield* Effect.fail(
                new CoreApiError(
                  500,
                  "internal_error",
                  "The workspace membership could not be loaded.",
                ),
              );
            }
            return {
              member: memberBody(joined.rows[0]),
              workspace: workspaceBody(workspace, joined.rows[0].role as WorkspaceRole),
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
        const role = yield* fromPromise(() => {
          const value = body.role;
          if (value !== "admin" && value !== "member") {
            throw new CoreApiError(400, "validation_error", "role must be admin or member.");
          }
          return value;
        });
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
              const { role: callerRole, workspace } = yield* requireMembership(
                client,
                workspaceId,
                actor,
              );
              yield* requireAdmin(callerRole);
              yield* requireTeamWorkspace(workspace);
              const target = yield* client.query<MemberRow>(
                `SELECT om.user_id, om.role, om.created_at, om.updated_at,
                        u.email, u.display_name, u.avatar_url
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
              if (member.role === "admin" && role === "member") {
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
                           u.email, u.display_name, u.avatar_url`,
                [workspaceId, memberId, role],
              );
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
              const { role: callerRole, workspace } = yield* requireMembership(
                client,
                workspaceId,
                actor,
              );
              const selfRemoval = memberId === actor.userId;
              if (!selfRemoval) {
                yield* requireAdmin(callerRole);
              }
              yield* requireTeamWorkspace(workspace);
              const target = yield* client.query<{ role: string }>(
                `SELECT role FROM org_members
                 WHERE org_id = $1 AND user_id = $2
                 FOR UPDATE`,
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
