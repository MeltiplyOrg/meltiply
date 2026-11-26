stabilizing

# Project State

This document owns contributor permissions and compatibility rules. The first line
declares the active state: `developing`, `stabilizing`, or `production`. Read it
before refactoring, schema changes, or data operations. Deployment environment names
do not select this policy.

In every state, ask the user before changing the OpenAPI specifications in
`packages/contracts`; change them only when genuinely required. Existing migration
files are immutable: add migrations rather than editing, reordering, or consolidating
them.

## `developing`

The project is in active pre-production development. Velocity, code cleanliness, and structural elegance take priority over backward compatibility and data preservation.

### Code refactoring

- **Clean cutovers**: Refactor code, signatures, abstractions, and module seams directly.
- **No compatibility shims**: Eliminate obsolete adapters, legacy parameters, and deprecated wrappers rather than preserving them.
- **Contract freedom**: Reshape internal and worker interfaces freely to match the cleanest design.

### Database schema and migrations

- **Migration-only schema changes**: Apply every schema change by adding a new migration script in `packages/database/migrations/`; never edit, reorder, or consolidate existing migration files.
- **Breaking schema alterations**: Add, rename, modify, or drop tables, columns, indexes, and constraints through new migrations without multi-phase migration wrappers.
- **No dual-write or backward-compatibility layers**: Write queries directly against the new schema; omit fallback columns and legacy query paths.

### Data management and persistence

- **Destructive resets permitted**: Wipe, truncate, recreate, or reseed local and development database instances at will.
- **Ephemeral data model**: Treat all stored entities, queue messages, and media assets as ephemeral test data; no data retention or migration safety is required.

---

## `stabilizing`

The MVP scope is frozen while release acceptance is established. This is not a claim
of production readiness or live Provider approval.

- **Release work first**: Fix existing workflows, correctness, security, accessibility,
  performance, deployment, recovery, and documentation. New capabilities require
  explicit user approval; avoid unrelated architectural rewrites.
- **Persistent data now**: Apply the persistent-installation safeguards below before
  the first live user. Local or staging data is not automatically disposable.
- **Acceptance evidence**: Use the [MVP release checklist](docs/release-acceptance.md)
  for the exact release candidate. Controlled-Provider tests do not establish live
  Provider acceptance; unavailable or untested capabilities stay unavailable.
- **Promotion**: Move to `production` only when the checklist's release decision is
  satisfied and the installation actually serves live users with persistent data.
  Continue maintenance in `production`; it does not mean development stops.

## `production`

The project serves live users with persistent data. The persistent-installation
safeguards remain mandatory during maintenance and future feature development.

## Persistent-installation safeguards

These rules apply in both `stabilizing` and `production`. Changing state does not
authorize destroying persistent data or bypassing compatibility requirements.

### Code refactoring

- **Contract continuity**: Maintain strict backward compatibility across all public HTTP endpoints, queue message schemas, webhook payloads, and worker interfaces.
- **Phased cutovers**: Deprecate interfaces before removal; support old and new contract shapes concurrently across deployment windows. Breaking changes require explicit review, a migration path, and the contract release procedure; a review token alone does not waive continuity.
- **Rollback safety**: Keep codebase changes backward-compatible with the immediately preceding deployment so rollbacks do not cause downtime or errors.

### Database schema and migrations

- **Expand and contract**: Expand additively; new columns must be nullable or supply defaults. Contract only in a later reviewed release after old code, clients, and in-flight work no longer depend on the removed shape.
- **No destructive schema operations**: Never drop or rename active tables, columns, or constraints in a single release.
- **Zero-downtime execution**: Author migrations that run safely while older and newer application workers execute concurrently.

### Data management and persistence

- **Preserve persistent state**: Protect database records, Hyperdrive connections, assets, encryption keys, and backups. Exercise a consistent restore on an isolated installation before relying on it.
- **Destructive operations prohibited**: Never truncate, drop, bulk wipe, or reseed a persistent installation as a development shortcut. Reset only explicitly identified, isolated disposable fixtures; normal authorized product deletion retains its documented semantics.
- **Async job and workflow safety**: Preserve in-flight queue jobs, cron triggers, workflows, and durable object state without disruption. Code rollback does not roll back stored state; verify compatibility or use a reviewed forward fix.
