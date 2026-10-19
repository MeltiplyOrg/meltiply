/**
 * Canonical Workspace role and capability model.
 *
 * This module is the single authority shared by the API Worker, the frontend,
 * and tests. Routes and services enforce capabilities; the frontend uses the
 * same map only to hide controls. A client is never the authorization boundary.
 */

/** Workspace roles, ordered from least to most authority for UI comparisons. */
export const WORKSPACE_ROLES = ["viewer", "editor", "admin"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Installation-wide Seat limit: active members plus pending invitations. */
export const INSTALLATION_SEAT_LIMIT = 10;

/**
 * One observable authority a caller may exercise.
 *
 * Capability names are stable API vocabulary: error codes and frontend gating
 * refer to the same values, so a role change updates every surface at once.
 */
export type WorkspaceCapability =
  | "audit:read"
  | "brand-profile:manage"
  | "brand-profile:read"
  | "channel:manage"
  | "channel:read"
  | "content:delete-published"
  | "content:read"
  | "content:write"
  | "installation:manage"
  | "member:assign-admin"
  | "member:assign-editor"
  | "member:assign-viewer"
  | "member:invite"
  | "member:manage"
  | "member:read"
  | "workspace:rename";

const ADMIN_CAPABILITIES: readonly WorkspaceCapability[] = [
  "audit:read",
  "brand-profile:manage",
  "brand-profile:read",
  "channel:manage",
  "channel:read",
  "content:delete-published",
  "content:read",
  "content:write",
  "member:assign-editor",
  "member:assign-viewer",
  "member:invite",
  "member:manage",
  "member:read",
  "workspace:rename",
];

const EDITOR_CAPABILITIES: readonly WorkspaceCapability[] = [
  "brand-profile:read",
  "channel:read",
  "content:read",
  "content:write",
];

const VIEWER_CAPABILITIES: readonly WorkspaceCapability[] = ["channel:read", "content:read"];

/**
 * Role capabilities. Workspace Admins deliberately cannot assign the Admin
 * role or modify another Admin; the Installation Owner supplies that extra
 * authority because ownership is installation-level, not a Workspace role.
 */
export const WORKSPACE_ROLE_CAPABILITIES: Readonly<
  Record<WorkspaceRole, readonly WorkspaceCapability[]>
> = {
  admin: ADMIN_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
};

/** Installation Owner capabilities layered on top of their Workspace Admin role. */
export const INSTALLATION_OWNER_CAPABILITIES: readonly WorkspaceCapability[] = [
  ...ADMIN_CAPABILITIES,
  "installation:manage",
  "member:assign-admin",
];

/**
 * Narrows an untrusted value to a Workspace role.
 *
 * @param value - Untrusted role value from a request body, JWT, or database row.
 * @returns True when the value is one of the three Workspace roles.
 */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "admin" || value === "editor" || value === "viewer";
}

/**
 * Answers whether a Workspace role grants a capability.
 *
 * @param role - Authoritative Workspace membership role.
 * @param capability - Capability being exercised.
 * @returns True when the role's capability set contains the capability.
 */
export function roleCan(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return WORKSPACE_ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Answers whether the resolved caller grants a capability, accounting for the
 * installation-level Owner authority that is separate from Workspace roles.
 *
 * @param role - Authoritative Workspace membership role.
 * @param installationOwner - True when the caller is the Installation Owner.
 * @param capability - Capability being exercised.
 * @returns True when either the role or ownership grants the capability.
 */
export function can(
  role: WorkspaceRole,
  installationOwner: boolean,
  capability: WorkspaceCapability,
): boolean {
  return (
    (installationOwner && INSTALLATION_OWNER_CAPABILITIES.includes(capability)) ||
    roleCan(role, capability)
  );
}
