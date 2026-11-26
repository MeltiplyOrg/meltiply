import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { can, isWorkspaceRole, type DatabaseError, type WorkspaceRole } from "@meltiply/domain";
import type { Context } from "hono";

import type { ResolvedActor } from "./actor-types";
import { CoreApiError } from "./api-errors";
import type { ApiWorkerEnvironment } from "./env";
import { errorResponse } from "./responses";

export function normalizeWorkspaceRole(role: string): WorkspaceRole {
  return isWorkspaceRole(role) ? role : "viewer";
}

export function requireActor(c: Context<ApiWorkerEnvironment>): ResolvedActor {
  const actor = c.get("actor");
  if (!actor) {
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  }
  return actor;
}

export function requireInstallationOwnerEffect(
  actor: ResolvedActor,
  message = "The installation owner role is required.",
): Effect.Effect<void, CoreApiError> {
  return actor.isInstallationOwner
    ? Effect.void
    : Effect.fail(new CoreApiError(403, "installation_owner_required", message));
}

export function requireWorkspaceAdminEffect(
  actor: ResolvedActor,
  message = "The workspace admin role is required.",
): Effect.Effect<void, CoreApiError> {
  return actor.role === "admin" || actor.isInstallationOwner
    ? Effect.void
    : Effect.fail(new CoreApiError(403, "workspace_admin_required", message));
}

export function requireActiveWorkspaceAdminEffect(
  client: EffectTransactionClient,
  message = "The workspace admin role is required.",
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return client
    .query<{ role: string | null }>("SELECT public.auth_active_org_role() AS role")
    .pipe(
      Effect.flatMap((result) =>
        result.rows[0]?.role === "admin"
          ? Effect.void
          : Effect.fail(new CoreApiError(403, "workspace_admin_required", message)),
      ),
    );
}

const queueMembershipPathPattern = /^\/api\/v1\/queues\/[^/]+\/posts\/[^/]+$/;

const CONTENT_WRITE_PREFIXES = [
  "/api/v1/asset-upload-sessions",
  "/api/v1/assets",
  "/api/v1/distributions",
  "/api/v1/inbox",
  "/api/v1/posts",
] as const;

const BRAND_PROFILE_PREFIX = "/api/v1/brand-profiles";
const CHANNEL_PREFIXES = ["/api/v1/oauth-selections", "/api/v1/platforms"] as const;
const CHANNEL_CONNECT_PATTERN = /^\/api\/v1\/platforms\/[^/]+\/connect$/;

export async function enforceWorkspaceCapabilities(
  c: Context<ApiWorkerEnvironment>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const actor = c.get("actor");
  if (!actor) return next();
  const path = c.req.path;
  const method = c.req.method;

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    if (
      CHANNEL_CONNECT_PATTERN.test(path) &&
      !can(actor.role, actor.isInstallationOwner, "channel:manage")
    ) {
      return errorResponse(
        c.get("requestId"),
        403,
        "forbidden_role",
        "Your workspace role cannot connect channels.",
      );
    }
    return next();
  }

  if (path.startsWith("/api/v1/queues")) {
    const membershipRemoval = queueMembershipPathPattern.test(path) && method === "DELETE";
    const allowed = can(
      actor.role,
      actor.isInstallationOwner,
      membershipRemoval ? "content:write" : "brand-profile:manage",
    );
    if (!allowed)
      return errorResponse(
        c.get("requestId"),
        403,
        "forbidden_role",
        "Your Workspace role cannot perform this Queue action.",
      );
    return next();
  }
  if (CONTENT_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    if (!can(actor.role, actor.isInstallationOwner, "content:write")) {
      return errorResponse(
        c.get("requestId"),
        403,
        "forbidden_role",
        "Your workspace role is read-only.",
      );
    }
    return next();
  }

  if (path.startsWith("/api/v1/publishing-preferences")) {
    if (!can(actor.role, actor.isInstallationOwner, "preferences:manage")) {
      return errorResponse(
        c.get("requestId"),
        403,
        "workspace_admin_required",
        "The workspace admin role is required.",
      );
    }
    return next();
  }

  if (path.startsWith(BRAND_PROFILE_PREFIX)) {
    if (!can(actor.role, actor.isInstallationOwner, "brand-profile:manage")) {
      return errorResponse(
        c.get("requestId"),
        403,
        "workspace_admin_required",
        "The workspace admin role is required.",
      );
    }
    return next();
  }

  if (CHANNEL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    if (!can(actor.role, actor.isInstallationOwner, "channel:manage")) {
      return errorResponse(
        c.get("requestId"),
        403,
        "workspace_admin_required",
        "The workspace admin role is required.",
      );
    }
    return next();
  }

  return next();
}
