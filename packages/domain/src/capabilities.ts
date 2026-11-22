/** Workspace roles, ordered from least to most authority. */
export const WORKSPACE_ROLES = ["viewer", "editor", "admin"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Installation-wide Seat limit: active members plus pending invitations. */
export const INSTALLATION_SEAT_LIMIT = 10;

/** Stable authority vocabulary shared by API enforcement and frontend gating. */
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

const VIEWER: readonly WorkspaceCapability[] = ["channel:read", "content:read"];
const EDITOR: readonly WorkspaceCapability[] = [...VIEWER, "brand-profile:read", "content:write"];
const ADMIN: readonly WorkspaceCapability[] = [
  ...EDITOR,
  "audit:read",
  "brand-profile:manage",
  "channel:manage",
  "content:delete-published",
  "member:assign-editor",
  "member:assign-viewer",
  "member:invite",
  "member:manage",
  "member:read",
  "preferences:manage",
  "workspace:rename",
];

const ROLE_CAPABILITIES: Readonly<Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>>> = {
  admin: new Set(ADMIN),
  editor: new Set(EDITOR),
  viewer: new Set(VIEWER),
};

const INSTALLATION_OWNER_CAPABILITIES: ReadonlySet<WorkspaceCapability> = new Set([
  ...ADMIN,
  "installation:manage",
  "member:assign-admin",
]);

const WORKSPACE_ROLE_SET: ReadonlySet<string> = new Set(WORKSPACE_ROLES);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && WORKSPACE_ROLE_SET.has(value);
}

/** The single authorization check: Installation Owner authority adds to, never replaces, the Workspace role. */
export function can(
  role: WorkspaceRole,
  installationOwner: boolean,
  capability: WorkspaceCapability,
): boolean {
  return (
    ROLE_CAPABILITIES[role].has(capability) ||
    (installationOwner && INSTALLATION_OWNER_CAPABILITIES.has(capability))
  );
}
