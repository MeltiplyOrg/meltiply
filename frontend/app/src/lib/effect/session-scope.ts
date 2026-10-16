import { Context } from "effect";

/**
 * Request scope captured by a calling hook for one query or mutation run.
 *
 * Authentication travels as an ambient same-origin Better Auth session cookie,
 * so the scope carries no credential: `isSignedIn` only gates whether a query
 * should fire at all, and `workspaceId` is the canonical Workspace selection
 * sent to the API as the `x-workspace-id` header (`null` selects the user's
 * personal workspace).
 */
export interface SessionScope {
  readonly isSignedIn: boolean;
  readonly workspaceId: string | null;
  /**
   * Active Brand Profile selection; `null` means the aggregate "All Brand
   * Profiles" view. Query hooks merge it into `brand_profile_id` params so
   * reads filter to the profile and mutations carry the required owner.
   */
  readonly brandProfileId: string | null;
}

/**
 * Service shape exposing the request-scoped Workspace selection.
 * The value is plain data rather than an `Effect` because `null` (personal
 * workspace) is a valid selection, not a failure.
 */
export interface WorkspaceServiceShape {
  readonly workspaceId: string | null;
}

/**
 * Service tag for accessing the request-scoped Workspace selection.
 *
 * Per the Effect v4 architecture, request-scoped values (session scope,
 * request IDs, tenancy) travel via `Context.Service`, never mutable global
 * singletons. The execution boundary provides the immutable selection directly
 * through `Effect.provideService`, keeping each query's tenancy isolated from
 * other in-flight requests; the API client resolves it when building the
 * `x-workspace-id` header.
 */
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  "WorkspaceService",
) {}
