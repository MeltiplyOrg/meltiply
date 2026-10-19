# Multi-user, invite-only roles: research notes

Status: research for the proposed shift away from the single-owner auth model.
Access date for all sources: 2026-10-19. Resolved Better Auth version in this
repository: **1.7.5** (`bun.lock`).

## Question

Meltiply currently accepts exactly one installation owner. The proposed model
is: the self-hoster becomes an installation-level administrator; only that
person may create workspaces; they invite members by email; up to 10 people can
sign in; workspace roles gate what each member can do. This note compares
Better Auth's built-in plugins with the existing custom schema and surveys how
established products model the same problem.

## Better Auth 1.7.5

### Organization plugin

Primary source: <https://better-auth.com/docs/plugins/organization>

Relevant built-in behavior:

- Default organization roles are `owner`, `admin`, and `member`. `owner` has
  full control; `admin` has full control except deleting the organization or
  changing the owner; `member` has read-only organization data.
- Built-in permission resources are narrow: `organization` (`update`,
  `delete`), `member` (`create`, `update`, `delete`), and `invitation`
  (`create`, `cancel`). They do not describe Posts, Channels, Brand Profiles,
  or publishing actions.
- Custom permissions are possible with `createAccessControl(statement)` and
  `ac.newRole(...)`, passed to the server and client plugins. Authorization is
  still application-enforced through `hasPermission`; the plugin does not
  protect application routes or database rows by itself.
- Invitations support `membershipLimit` (per organization, default 100),
  `invitationExpiresIn` (default 48 hours), `resend`,
  `cancelPendingInvitationsOnReInvite`, and
  `requireEmailVerificationOnInvitation`. Acceptance requires a logged-in
  session whose email matches the invitation.
- `allowUserToCreateOrganization` can restrict organization creation to a
  predicate over the user, and `organizationLimit` can cap organizations per
  user.
- Schema is customizable: `schema.organization.modelName` and field mappings
  can point at existing tables, and `additionalFields` can extend them.
- The plugin's own tables are `organization`, `member`, `invitation`,
  `organizationRole` (dynamic roles), and optional `team` / `teamMember`; it
  also adds active-organization fields to `session`.

Fit against Meltiply's schema:

| Better Auth plugin | Meltiply today | Gap |
| --- | --- | --- |
| `organization` (`name`, `slug`, `logo`, `metadata`) | `organizations` (`name`, `slug`, `personal_user_id`, `plan`, `billing_status`, timestamps) | Field mapping possible; `personal_user_id` has no plugin meaning. |
| `member` (`organizationId`, `userId`, `role`, `createdAt`) | `org_members` (`id`, `org_id`, `user_id`, `role`, timestamps) with `CHECK role IN ('admin','member')` | Role constraint must gain `owner`/new roles; invitation acceptance and RLS already read this table. |
| `invitation` (ID, email, role, status, expiresAt, inviterId) | `workspace_invitations` (hashed token, email, role, invited_by, expires_at, accepted_at, revoked_at) | Plugin accepts by invitation ID; Meltiply stores only a hash of a separate token. Mapping would either weaken token-at-rest secrecy or require custom flow code. |
| Session active organization | Workspace selected per request via `x-workspace-id` | Plugin's session field is redundant; Meltiply deliberately keeps selection per request and re-validates membership. |
| RLS | `auth_active_org_id()` / `auth_active_org_role()` read `org_members` | Plugin does not participate in PostgreSQL RLS. |
| Contracts | Hand-written OpenAPI and generated client | Plugin endpoints would add a second API surface with different error shapes. |

### Admin plugin

Primary source: <https://better-auth.com/docs/plugins/admin>

Relevant built-in behavior:

- Adds `role`, `banned`, `banReason`, and `banExpires` to the auth user, plus
  an impersonation marker on sessions.
- Provides user management endpoints: create user, list/get user, set role,
  set password, update user, ban/unban (ban also revokes existing sessions),
  list/revoke sessions, impersonate, and hard-delete.
- Default roles are `admin` and `user`; custom access control can define more.
  Admin status can also come from `adminUserIds`.
- The first admin is created with the `auth create-admin` CLI.

Fit: useful as a reference for account lifecycle, but adopting it would place
user-management endpoints under `/api/auth/*`, authenticated by session
cookies. Meltiply's protected application API is bearer-JWT-only and resolves
its own actor. It also already has a durable audit table for operator actions
and hand-written contracts; adding the plugin would create a second
authorization and API plane.

### Recommendation

**Hybrid, weighted toward the existing custom schema.** Keep Better Auth for
identity, sessions, JWT minting, verification, password recovery, and 2FA.
Extend the existing `organizations` / `org_members` /
`workspace_invitations` tables and API for the new roles and invitation flow.
Borrow the admin plugin's user-lifecycle semantics (ban/suspend, revoke
sessions, last-owner protection) without mounting its routes.

Why not adopt the organization plugin wholesale:

1. It adds no row-level authorization; Meltiply would still enforce roles in
   services and RLS.
2. Its permission vocabulary covers organization administration, not Posts,
   Channels, Brand Profiles, or publishing. Custom statements would be needed
   anyway.
3. Its invitation model accepts by invitation ID; Meltiply's current hashed
   bearer token is a stronger at-rest design and is already implemented.
4. Mapping Better Auth-managed tables onto the existing schema adds migration
   and dual-ownership risk for a feature whose actual authorization logic
   remains custom.
5. The repo's contracts, tests, and frontend are built around `/api/v1` and the
   internal `organizations` model, not Better Auth's organization endpoints.

The one plugin worth considering is the **admin plugin's schema and account
operations**, because reimplementing ban/session-revocation semantics is easy to
get subtly wrong. Even then, expose them through Meltiply's `/api/v1` admin
routes and audit them, rather than exposing `/api/auth/admin/*` directly.

## Industry patterns

### Role taxonomies

| Product | Roles | Notable constraint |
| --- | --- | --- |
| GitLab | Minimal Access, Guest, Planner, Reporter, Security Manager, Developer, Maintainer, Owner; optional custom roles | Roles cumulative; highest role wins; administrator access is separate and global ([source](https://docs.gitlab.com/user/permissions/)). |
| Mattermost | System admin, team admin, channel admin, member, guest, deactivated | First user becomes system admin; system admin is the only role that can modify another system admin ([source](https://docs.mattermost.com/collaborate/learn-about-roles)). |
| Slack | Primary owner, owners, admins, full members, guests, channel managers | Exactly one primary owner; only they can delete or transfer the workspace; owners can appoint owners ([source](https://slack.com/help/articles/360018112273-Types-of-roles-in-Slack)). |
| Linear | Workspace owner, admin, team owner, member, guest | Owner is Enterprise-only; admins manage routine operations; suspension removes access immediately but retains history ([source](https://linear.app/docs/members-roles)). |
| Vercel | Owner, member, developer, security, billing, viewers, contributor; project-level roles | Multiple owners recommended; only owners manage member roles; ordinary members cannot invite by default ([source](https://vercel.com/docs/rbac/access-roles)). |
| GitHub | Owner, member, moderator, billing manager, security manager; custom org roles (Enterprise) | Owners have complete administrative access; docs recommend at least two owners ([source](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/roles-in-an-organization)). |
| Notion | Workspace owner, membership admin, member, restricted member, guest | Every workspace has at least one owner; removal revokes access instantly; rejoin within 30 days restores private pages ([source](https://www.notion.com/help/whos-who-in-a-workspace)). |
| Outline | Admin, editor, viewer, guest | First user becomes admin; suspending prevents login, revokes sessions, and frees the seat while retaining data; deleting is irreversible and anonymizes content ([source](https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V)). |
| Cal.com | Organization owner/admin/member; team owner/admin/member; optional PBAC custom roles | A caller cannot assign a role higher than their own, cannot modify a higher role, and a team owner cannot remove their own membership; ownership must be transferred ([source](https://cal.com/docs/api-reference/v2/access-control)). |

### Invitation and signup policy

- Mattermost makes the strongest direct precedent for invite-only self-hosting:
  `EnableOpenServer` defaults to `false`, so users must have an invitation to
  create an account on a self-hosted server; email invitations themselves are
  disabled by default in self-hosted deployments
  ([source](https://docs.mattermost.com/administration-guide/configure/authentication-configuration-settings)).
- Better Auth's organization invitation model binds acceptance to a logged-in
  session with a matching email and supports expiry, revocation, resend, and a
  membership cap
  ([source](https://better-auth.com/docs/plugins/organization)).
- Slack distinguishes invited members who have not accepted yet from full
  members, and gives invited members limited visibility before acceptance
  ([source](https://slack.com/help/articles/360018112273-Types-of-roles-in-Slack)).
- Linear and Outline retain suspended users for historical attribution while
  removing access and, in Outline's case, the billed seat
  ([Linear](https://linear.app/docs/members-roles),
  [Outline](https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V)).

### Ownership continuity

Every product that documents ownership treats a single owner as a continuity
risk:

- Slack has one primary owner but allows multiple owners; only the primary can
  transfer or delete.
- GitHub recommends at least two organization owners.
- Vercel recommends at least two owners for continuity.
- Notion requires at least one workspace owner.
- Cal.com prevents a team owner from removing their own membership and
  requires ownership transfer first.

**Implication for Meltiply:** a single Installation Owner is acceptable for the
initial bootstrap, but the design needs an explicit transfer/recovery path and
should allow at least one additional owner or a documented break-glass
procedure. Otherwise the installation becomes unadministrable if the owner
leaves or loses access.

### Seat limits

- Better Auth implements a per-organization `membershipLimit`; it is a
  configuration number or a function, not a billing system
  ([source](https://better-auth.com/docs/plugins/organization)).
- Established products generally count active members for billing or access
  and free the seat on suspension or removal (Outline, Linear, Notion guests),
  while retaining historical attribution.
- No surveyed product enforces a hard 10-person cap as a product rule; this is
  a Meltiply-specific constraint and should be enforced in the invitation
  acceptance path, not only in the UI.

## Recommended direction for Meltiply

1. **Identity:** keep Better Auth email/password + TOTP + verification. Remove
   the `installationOwner`-only session gate; replace it with a general
   `users.role` or installation-membership marker that identifies the owner.
2. **Installation vs workspace roles:** separate the singleton **Installation
   Owner** (account/workspace administration) from per-workspace **Admin /
   Editor / Viewer**. Workspace authorization continues to resolve from
   `org_members` and RLS, not from JWT claims.
3. **Roles:** fixed roles first. Define capabilities as data or constants, with
   a fixed mapping per role. Do not build a custom-role editor until demanded;
   Cal.com and GitHub gate custom roles behind enterprise plans for good
   reason.
4. **Invitations:** keep the existing hashed-token invitation table. Add
   invite-only signup: after bootstrap, an account can only be created from a
   valid invitation bound to the invited email. Existing accounts accept the
   same link after sign-in. Require verified email.
5. **Seat cap:** enforce 10 active accounts (or 10 members, depending on the
   workspace decision) at invitation creation and acceptance, inside the same
   transaction that inserts the membership. Decide whether pending invitations
   reserve seats.
6. **Account lifecycle:** prefer suspend/disable over hard delete. Suspension
   revokes sessions and retains attribution. Hard delete only as an explicit
   destructive action.
7. **Owner continuity:** document and implement ownership transfer; protect the
   last owner from demotion/removal, matching Cal.com and GitLab.
8. **Audit:** every invitation, role change, suspension, and ownership change
   should write a durable audit row, reusing the `operator_actions` pattern or
   a sibling `admin_actions` table.

## Open decisions this research does not settle

- Whether Meltiply is one shared workspace per installation or multiple
  owner-created workspaces.
- Whether the Installation Owner may read/write workspace content without
  membership.
- Whether the 10-person cap is installation-wide or per workspace, and whether
  pending invitations consume seats.
- Whether role changes and invitations are audited in v1.
- Whether custom roles are ever exposed, or only fixed roles with a capability
  map.
