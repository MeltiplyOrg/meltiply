import { useMemo } from "react";

import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import type { SessionScope } from "@/lib/effect";

/**
 * React hook exposing the authenticated session scope for API-bound queries.
 *
 * Session transport is the HttpOnly Better Auth cookie on the same origin, so
 * consumers receive only whether a session is available (`isSignedIn`) and the
 * explicitly selected Workspace (`workspaceId`, `null` for the personal
 * workspace) and Brand Profile (`brandProfileId`, `null` for the aggregate
 * "All Brand Profiles" view) — never an authentication credential. Query hooks
 * pass the returned scope to `runFrontendEffect`, which binds `workspaceId`
 * into the request-scoped `WorkspaceService` so the API receives the
 * `x-workspace-id` selection header; hooks merge `brandProfileId` into
 * `brand_profile_id` params themselves. The memoized result keeps a stable
 * reference per (isSignedIn, workspaceId, brandProfileId) triple so consumers
 * can safely use the scope in dependency arrays.
 *
 * @returns The `SessionScope` describing cookie-session availability and the
 *   selected workspace and brand profile for the current user.
 */
export function useSessionScope(): SessionScope {
  const { isSignedIn, workspaceId, brandProfileId } = useMeltiplyAuth();
  return useMemo(
    () => ({ isSignedIn, workspaceId, brandProfileId }),
    [isSignedIn, workspaceId, brandProfileId],
  );
}
