import { can } from "@meltiply/domain";
import type { Context } from "hono";

import type { ApiWorkerEnvironment } from "./env";
import { errorResponse } from "./responses";

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

/**
 * Enforces the Workspace capability map on content and configuration routes.
 *
 * This is a routing guard, not the authorization authority: services re-check
 * the role inside transactions and PostgreSQL RLS is the final boundary. The
 * guard exists so a Viewer or Editor receives an immediate, stable
 * `forbidden_role` error for an operation their role cannot perform instead of
 * relying on incidental service behavior. Reads are always allowed; the
 * role-specific read rules (Audit, deleted Brand Profiles) live in their
 * services.
 *
 * @param c - Hono request context carrying the resolved actor.
 * @param next - Downstream request handler.
 * @returns Promise resolving after the request or the 403 response.
 */
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
