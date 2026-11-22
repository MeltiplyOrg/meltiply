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
  | "preferences:manage"
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
  "preferences:manage",
  "workspace:rename",
];

const EDITOR_CAPABILITIES: readonly WorkspaceCapability[] = [
  "brand-profile:read",
  "channel:read",
  "content:read",
  "content:write",
];

const VIEWER_CAPABILITIES: readonly WorkspaceCapability[] = ["channel:read", "content:read"];

const ADMIN_CAPABILITY_SET: ReadonlySet<WorkspaceCapability> = new Set(ADMIN_CAPABILITIES);
const EDITOR_CAPABILITY_SET: ReadonlySet<WorkspaceCapability> = new Set(EDITOR_CAPABILITIES);
const VIEWER_CAPABILITY_SET: ReadonlySet<WorkspaceCapability> = new Set(VIEWER_CAPABILITIES);
const OWNER_CAPABILITY_SET: ReadonlySet<WorkspaceCapability> = new Set([
  ...ADMIN_CAPABILITIES,
  "installation:manage",
  "member:assign-admin",
]);

const ROLE_CAPABILITY_SETS: Readonly<Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>>> = {
  admin: ADMIN_CAPABILITY_SET,
  editor: EDITOR_CAPABILITY_SET,
  viewer: VIEWER_CAPABILITY_SET,
};

const WORKSPACE_ROLE_SET: ReadonlySet<string> = new Set(WORKSPACE_ROLES);

export const WORKSPACE_ROLE_CAPABILITIES: Readonly<
  Record<WorkspaceRole, readonly WorkspaceCapability[]>
> = {
  admin: ADMIN_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
};

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
  return typeof value === "string" && WORKSPACE_ROLE_SET.has(value);
}

/**
 * Answers whether a Workspace role grants a capability.
 *
 * @param role - Authoritative Workspace membership role.
 * @param capability - Capability being exercised.
 * @returns True when the role's capability set contains the capability.
 */
export function roleCan(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return ROLE_CAPABILITY_SETS[role].has(capability);
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
    (installationOwner && OWNER_CAPABILITY_SET.has(capability)) ||
    ROLE_CAPABILITY_SETS[role].has(capability)
  );
}
