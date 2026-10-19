# Multi-user roles: Better Auth and industry comparison

This note records the alternatives considered for Meltiply's invite-only,
single-Workspace multi-user model. It explains why the repository keeps Better
Auth for identity only and owns membership, invitations, and authorization.

## Better Auth organization plugin

The organization plugin supplies organizations, members, invitations, roles,
and active-organization switching. It was not adopted for three reasons:

- **No row-level authorization.** Plugin roles do not translate into PostgreSQL
  policies for Posts, Assets, Channels, Brand Profiles, or Distributions. The
  database would have no defense-in-depth boundary.
- **Weaker invitation tokens.** Its invitation-ID flow stores an identifier that
  is accepted directly. Meltiply already hashes single-use tokens so a database
  read cannot disclose a usable link.
- **Multiple organizations by design.** Meltiply has exactly one shared
  Workspace; the plugin's switching model would add a second source of active
  tenant state beside `X-Workspace-ID` and RLS claims.

## Better Auth admin plugin

The admin plugin's account lifecycle semantics informed this design: explicit
ban/suspend, immediate session revocation, and explicit account removal. The
implementation borrows those semantics but exposes them through Meltiply's
bearer-JWT API and internal user record, not through Better Auth HTTP routes.
Better Auth remains the credential, session, verification, recovery, and 2FA
authority.

## Role model

Three Workspace roles — Admin, Editor, Viewer — are the smallest set that
separates content work, configuration, and administration:

| Capability                                                           | Viewer | Editor | Admin | Installation Owner |
| -------------------------------------------------------------------- | ------ | ------ | ----- | ------------------ |
| Read Posts, Channels, analytics, Inbox                               | yes    | yes    | yes   | yes                |
| Create/edit Posts, upload Assets, publish, reply                     | no     | yes    | yes   | yes                |
| Delete a Post with published Distributions                           | no     | no     | yes   | yes                |
| Read Channels and Brand Profiles                                     | yes    | yes    | yes   | yes                |
| Connect/disconnect Channels; manage Brand Profiles                   | no     | no     | yes   | yes                |
| Manage Editors/Viewers, invitations, Workspace name, Audit           | no     | no     | yes   | yes                |
| Assign Admin; suspend/reactivate/delete accounts; transfer ownership | no     | no     | no    | yes                |

Installation Ownership is deliberately not a Workspace role. It is
installation-level authority with a singleton database constraint, so it cannot
be invited, delegated through membership, or silently granted by a role change.
The Owner uses their Admin membership for content; ownership never bypasses RLS.

## Industry comparison

- **Slack / Notion / Linear** separate workspace administration from content
  roles and protect the last administrator. Invitations are email-bound and
  expire.
- **GitHub** treats the organization owner as a distinct escrow-like role with
  ownership transfer requiring reauthentication.
- **Google Workspace** separates super-admin authority from per-resource sharing
  and documents a break-glass recovery path.
- **Small self-hosted tools** commonly stop at a single owner and then bolt on
  membership without RLS, which makes the API the only authorization boundary.

Meltiply combines the small-team shape with two boundaries: capability checks in
services and explicit PostgreSQL RLS predicates. The frontend reads the same
capability map to hide controls, but it is never trusted for authorization.
